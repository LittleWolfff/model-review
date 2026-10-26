/* ============================================================
   glbview —— 网站里所有"看模型"的事都归这儿管：
     产出卡片的缩略图 / 实测三角面数 / 点开的大预览 / 5·6 站的渲染台

   ⚠️ **这个文件是源码**。网站里用的那份是 `build.py` 内联进去的副本 ——
      改完这里**记得跑一次**：python scripts/build.py
   （为什么要内联而不是外链：`file://` 下外链的 ES module 会被浏览器
     的 CORS 挡掉，只有内嵌的不受限。网站走 file:// 是为了不丢数据。）

   单独调试：直接开 `glbview/viewer.html`
   为什么这么拆、留了哪些口子 → `glbview/CLAUDE.md`
   ============================================================ */


/* 3D 预览：用 three.js 把模型转着看。
   为什么要单独一个 module script：three 现在是 ES module，普通 <script> 引不动。
   主代码是 IIFE，拿不到 module 里的东西 —— 所以这里只往外暴露两个函数。 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
/* 🆕 2026-10-15：`toCreasedNormals` —— **Blender 那个「自动平滑」的等价物**（见下面 `pv3dApplyAutoSmooth`）。
   ⚠️ 它**本来就在 vendor 包里**：`BufferGeometryUtils` 是 `GLTFLoader` 的依赖，早被一起打进去了
      → **这一行零新增体积**，不用碰 build 流程（查过 vendor 的 `MODS` 表，导出列表里有它）。 */
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
/* 环境光（PMREM 用）—— 用 three **内置**的 RoomEnvironment：不下载 HDR 文件、零外部资源。
   为什么要它：现在只有几个死板平行光，PBR 材质没有环境反射 → 高光/反射全丢，看着像塑料。 */
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
/* 后处理（Bloom）—— 调研说这是"出成品图感"最划算的一步，且零新依赖（addons 同一个 CDN）。
   ⚠️ 加了它就得**走 composer 渲染**，而且**色调映射交给 OutputPass 统一做**
      （renderer.toneMapping 要设回 NoToneMapping，不然会做两遍、画面发暗）。 */
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

var renderer, scene, camera, controls, holder;
/* ⚠️ pv3d / msg / nameEl 的初始化**挪到下面去了**（PV3D_CSS / PV3D_HTML 定义之后）——
   踩过：`var` 只提升声明不提升赋值，在这几行调 pv3dEnsurePanel() 时
   PV3D_HTML 还是 undefined → innerHTML 塞了个空字符串 → 建出个**空壳**，
   里面那些按钮全找不到（报 "Cannot read properties of null (reading 'addEventListener')"）。 */
var booted = false;

function boot(){
  if (booted) return;
  var box = document.querySelector('.pv3d-box');
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(box.clientWidth, box.clientHeight);
  // canvas 挂在右边那格里（左边留给四视图）
  var stage = document.getElementById('pv3dStage');
  (stage || box).appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(35, box.clientWidth / box.clientHeight, 0.01, 200);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a8f80, 2.4));
  var d1 = new THREE.DirectionalLight(0xffffff, 1.9); d1.position.set(1.2, 2.2, 2.4); scene.add(d1);
  var d2 = new THREE.DirectionalLight(0xffffff, 0.8); d2.position.set(-2, 1.2, -1.4); scene.add(d2);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  // 🔴 双击复位：**不能挂在 controls 上** —— OrbitControls 只派发
  //    change / start / end，压根没有 dblclick 事件，挂了永远不会触发（踩过，
  //    表现是「提示里写着双击复位，但双击没反应」）。要挂到它管的那个 canvas 上。
  renderer.domElement.addEventListener('dblclick', function(){ frame(holder); });

  holder = new THREE.Group();
  scene.add(holder);

  pv3dClock = new THREE.Clock();
  renderer.setAnimationLoop(function(){
    controls.update();
    // 动画（4.3 之后的产出才带）—— 用 `timeScale` 控制播/停，不重置进度
    /* A-Pose 模式下**别**让 mixer 再写骨架 —— 它每帧都会按当前时间摆姿势，
       会把 `Skeleton.pose()` 刚恢复的绑定姿势盖掉。 */
    if (pv3dMixer && !pv3dRestMode) pv3dMixer.update(pv3dClock.getDelta());
    renderer.render(scene, camera);
    /* 骨名标签每帧跟着骨头走（模型转、相机动都要重算投影） */
    if (pv3dBoneLabels.length) pv3dPlaceBoneLabels();
  });
  window.addEventListener('resize', function(){ window.pv3dFit && window.pv3dFit(); });
  booted = true;
}

/* 模型的**真实**包围盒 —— 定相机（构图）、判"骨架跟模型配不配"，都用它。

   🔴 **别用 `Box3.setFromObject()` / `expandByObject()`** —— 对蒙皮网格（`SkinnedMesh`）
   它们**不算数**：glb 里顶点存的是**绑骨前**的坐标，实际显示在哪儿由**骨骼矩阵**决定。
   骨架带缩放时差得离谱 —— 4.1 的产物实测：网格量出来**高 0.47**，蒙皮后其实是**高 0.86**
   （骨架就是按 3.1 白模那个高 1.0 的模型生成的）。
   相机照 0.47 去凑 → 太近 → **模型被画面裁掉**。

   ⚠️ 阿聪 2026-10-06 报过「4.1 的视角**突然这么大**」。当时的诊断是
      "`setFromObject` 把 22 根骨也算进包围盒了"，于是改成**只算网格** ——
      症状压住了，**根因没动**：真正的问题从来不是"多算了骨头"，
      而是"**少算了蒙皮**"。两种错法都会把相机搞歪，方向刚好相反。 */
function pv3dModelBox(obj){
  var bb = new THREE.Box3(), tmp = new THREE.Box3();
  if (!obj) return bb;
  obj.updateMatrixWorld(true);       // 骨骼矩阵得是新的，下面要靠它
  obj.traverse(function(o){
    if (!o.isMesh || !o.geometry) return;
    if (o.isSkinnedMesh && o.skeleton){
      /* 让 Three 自己按**当前骨骼**算一遍（它会逐顶点做蒙皮变换） */
      o.computeBoundingBox();
      if (o.boundingBox){
        tmp.copy(o.boundingBox).applyMatrix4(o.matrixWorld);
        bb.union(tmp);
      }
    } else {
      bb.expandByObject(o);
    }
  });
  if (bb.isEmpty()) bb.setFromObject(obj);   // 兜底：一个网格都没有
  return bb;
}

function frame(obj){
  if (!obj) return;
  var bb = pv3dModelBox(obj);
  if (bb.isEmpty()) return;
  var size = bb.getSize(new THREE.Vector3());
  var center = bb.getCenter(new THREE.Vector3());
  var maxDim = Math.max(size.x, size.y, size.z) || 1;
  var dist = maxDim / (2 * Math.tan(Math.PI * camera.fov / 360)) * 1.7;
  camera.position.set(center.x, center.y + size.y * 0.04, center.z + dist);
  camera.near = maxDim / 200;
  camera.far = maxDim * 60;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
  controls.update();
}

function clearHolder(){
  while (holder.children.length){
    var c = holder.children.pop();
    holder.remove(c);
    c.traverse && c.traverse(function(o){
      if (o.geometry) o.geometry.dispose();
      if (o.material){
        var ms = Array.isArray(o.material) ? o.material : [o.material];
        ms.forEach(function(m){
          Object.keys(m).forEach(function(k){
            if (m[k] && m[k].isTexture) m[k].dispose();
          });
          m.dispose();
        });
      }
    });
  }
}

/* 按弹层当前的实际尺寸重设渲染器 —— 打开时、窗口变了都要调。
   ⚠️ 别在没有尺寸的时候硬设（会得到 0×0 的白画布）。
   ⚠️ 这个必须放在 module 顶层 —— 一开始写在 boot() 里面了，外面根本调不到，
      表现是「预览起不来：fitPv3d is not defined」（函数声明只在自己那个函数体里提升）。 */
function fitPv3d(){
  if (!renderer || pv3d.hidden) return;
  var b = document.getElementById('pv3dStage') || document.querySelector('.pv3d-box');
  var w = b.clientWidth, h = b.clientHeight;
  if (!w || !h) return;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.pv3dFit = fitPv3d;

/* 给别的能力单元用的口子 —— glbview 只管「看」和「选中」，
   拿到之后要**改**什么（比如 uvtool 要重展 UV）是别人的事。
   ⚠️ 顺序：调这个之前得先 pv3dOpen 过。 */
window.pv3dScene = function(){
  if (!pv3dObj) return null;
  return { obj: pv3dObj, camera: camera, holder: holder, stage: document.getElementById('pv3dStage') };
};
window.pv3dExport = function(mesh, cb){
  new GLTFExporter().parse(mesh, function(glb){ cb(new Blob([glb], { type: 'model/gltf-binary' })); },
                           function(e){ console.error('[glbview 导出] 失败', e); cb(null); }, { binary: true });
};
window.pv3dStamp = function(){                       // 给导出文件起名用（本地时间）
  var d = new Date(), p = function(n){ return (n < 10 ? '0' : '') + n; };
  return p(d.getMonth() + 1) + p(d.getDate()) + p(d.getHours()) + p(d.getMinutes());
};


/* ---------- 产出缩略图：给产出列表里每个模型出一张小图 ----------
   阿聪 2026-10-03：「我希望的是，那个预览窗口**直接显示在这里**，能直观看也能直观挑选嘛，
   然后点击可以放大预览」—— 一行文件名 + 一个「看一下」按钮确实太费劲，
   美术要的是扫一眼就知道哪个好。

   ⚠️ **不能给每张缩略图都建一个 WebGLRenderer** —— 浏览器对同时存在的 WebGL context
      有硬上限（一般 8~16 个），产出一多就整片黑。所以这里**只建一个离屏渲染器反复用**，
      串行出图（一次一张），用完不销毁、下次接着用。 */
var THUMB = { r: null, scene: null, cam: null, holder: null, size: 256 };

function thumbInit(){
  if (THUMB.r) return;
  var r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(THUMB.size, THUMB.size, false);
  r.toneMapping = THREE.ACESFilmicToneMapping;
  THUMB.r = r;

  var sc = new THREE.Scene();
  sc.background = new THREE.Color(0xf7f3ec);
  sc.add(new THREE.HemisphereLight(0xffffff, 0x9a8f80, 2.0));
  var key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(1.6, 2.6, 2.2); sc.add(key);
  var fill = new THREE.DirectionalLight(0xffffff, 0.8);
  fill.position.set(-2.0, 1.2, 1.2); sc.add(fill);
  THUMB.scene = sc;
  THUMB.cam = new THREE.PerspectiveCamera(32, 1, 0.01, 500);
  THUMB.holder = new THREE.Group();
  sc.add(THUMB.holder);
}

function thumbClear(){
  while (THUMB.holder.children.length){
    var c = THUMB.holder.children.pop();
    THUMB.holder.remove(c);
    c.traverse && c.traverse(function(o){
      if (o.geometry) o.geometry.dispose();
      if (o.material){
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
          Object.keys(m).forEach(function(k){ if (m[k] && m[k].isTexture) m[k].dispose(); });
          m.dispose();
        });
      }
    });
  }
}

/* 出图。回调给的是 (PNG 的 dataURL, 三角面数)；打不开就给 (null, 0)。
   🔑 **顺便数三角面**（阿聪 2026-10-04：「面数是指…有显示具体多少的数字」）——
      他之前看到的是挡位名（「70 万面」= 他选的上限），**不是模型实际的面数**。
      缩略图反正要把模型加载一遍，就在这儿数，不额外花时间。 */
window.studioThumb = function(url, size, cb, opts){
  try{
    thumbInit();
    var px = Math.max(96, Math.min(512, size || THUMB.size));
    THUMB.r.setSize(px, px, false);
    thumbClear();

    new GLTFLoader().load(url, function(g){
      var obj = g.scene || g.scenes[0];
      THUMB.holder.add(obj);

      /* 缩略图也可以出**UV 色块版**（阿聪 2026-10-04：「这个预览能不能显示 uv 啊」——
         说的是卡片上那张缩略图）。宿主用 opts.uv 说要不要。
         缩略图是另一套场景、出完就 thumbClear() 放掉，所以不用摘回去。 */
      if (opts && opts.uv) pv3dSetUVChecker(obj, true);
      /* 3.1「烘焙法线」那步的卡片要的是**铺法线版**（阿聪 2026-10-06：
         「点进去后确实默认预览纯法线，但是**预览图还是白模**」）——
         卡片上那张小图也该一眼看出"我烘的是啥"，而不是一个白模。 */
      if (opts && opts.normal) pv3dThumbShowNormal(obj);
      /* 🆕 「白模」（阿聪 2026-10-14）—— 跟上面两条一个道理：缩略图是**另一套一次性场景**，
         出完 `thumbClear()` 就放掉，所以直接 `on=true`、不用摘回去。
         ⚠️ 放**最后**：它跟 uv / normal 互斥，真撞上了也是"看纯几何"说了算。 */
      if (opts && opts.white) pv3dSetWhite(obj, true);
      /* 4.1「生成骨架」那步的小图要的是**带骨架版**（阿聪 2026-10-06：
         「我这看着还是没」）—— 那一步交的就是"带骨架的 glb"，
         小图上光看白模等于没验这一步干了啥。跟 3.1 小图铺法线一个道理。 */
      if (opts && opts.skel) pv3dThumbShowSkeleton(obj);
      /* 「显示布线」也要能出到小图上（2026-10-06，跟骨架同一天加的）——
         它在弹层里是个**叠加层**（盖在模型上的线），所以跟上面几个不冲突、可以同时开。 */
      if (opts && opts.wire) pv3dThumbShowWire(obj);

      /* 「动画模式」的缩略图（阿聪 2026-10-07：「动画也是，glbview，**默认动画模式**」）——
         把这段动作**推到中段**（起点常常是 T 字 / 第一帧，看不出动作），
         用 `mixer.update(t)` 直接摆姿势，不用开渲染循环。
         🔴 **必须在下面 `render()` 之前摆好** —— 我第一版把它插在 render 之后，
            结果是"姿势摆了，图已经拍完了"，三张动画卡长得跟网格卡一模一样
            （2026-10-07 在真页面上看出来的）。 */
      if (opts && opts.anim != null){
        var clips = (g.animations || []);
        if (clips.length){
          var clip = clips[Math.min(opts.anim, clips.length - 1)];
          var mx = new THREE.AnimationMixer(obj);
          mx.clipAction(clip).play();
          mx.update(clip.duration * 0.35);
        }
      }

      // 自动构图：整个模型塞进画面，留一圈边
      // 用 `pv3dModelBox`（会算上蒙皮）—— 别自己 traverse，见那个函数的注释
      var bb = pv3dModelBox(obj);
      if (bb.isEmpty()){ cb(null); return; }
      var sz = bb.getSize(new THREE.Vector3());
      var ct = bb.getCenter(new THREE.Vector3());
      var maxDim = Math.max(sz.x, sz.y, sz.z) || 1;
      var dist = maxDim / (2 * Math.tan(Math.PI * THUMB.cam.fov / 360)) * 1.5;
      // 稍微偏一点角度，比死正面好认（能看出侧面轮廓）
      THUMB.cam.position.set(ct.x + dist * 0.32, ct.y + sz.y * 0.06, ct.z + dist * 0.95);
      THUMB.cam.near = maxDim / 200;
      THUMB.cam.far = maxDim * 80;
      THUMB.cam.lookAt(ct);
      THUMB.cam.updateProjectionMatrix();

      THUMB.r.render(THUMB.scene, THUMB.cam);
      var data = THUMB.r.domElement.toDataURL('image/png');

      // 数三角面：有 index 就按 index 数，没有就按顶点数 / 3
      var tri = 0;
      obj.traverse(function(o){
        if (o.isMesh && o.geometry){
          var geo = o.geometry;
          tri += Math.round((geo.index ? geo.index.count
                                       : (geo.attributes.position ? geo.attributes.position.count : 0)) / 3);
        }
      });

      thumbClear();                                   // 出完就放掉显存
      cb(data, tri);
    }, undefined, function(){ thumbClear(); cb(null, 0); });
  }catch(e){
    // ⚠️ 这是**同步**那段抛出来的（异步回调里的异常走不到这儿，见上面的 onError）
    try{ console.error('[glbview] 缩略图：开头就出错了', e); }catch(_){}
    cb(null, 0);
  }
};


/* 把 `t.image`（Image / ImageBitmap / canvas）画成 dataURL —— 给贴图卡片当预览用。 */
function _pv3dTexURL(img){
  try{
    var w = img.width || img.videoWidth || 128;
    var h = img.height || img.videoHeight || 128;
    var c = document.createElement('canvas');
    var s = Math.min(1, 256 / Math.max(w, h, 1));
    c.width = Math.max(1, Math.round(w * s));
    c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/png');
  }catch(e){ return ''; }
}

/* 读一个 glb 的**清单信息** —— 一次加载，把 5.2 那张「最终导入结果」要的都读出来：
     三角面数 / 动画（名字 + 时长）/ 有没有骨架 / 贴图（槽位 + 图，转成 dataURL）
   阿聪 2026-10-07：「能不能直接生成个预览……其实我想要的的效果就是类似 ue 这样，
   **上面有预览，下面是真实导入的名字**」。
   ⚠️ 贴图按**槽位**认（`map` = 颜色、`normalMap` = 法线）—— 比"猜文件名"准得多。 */
window.pv3dInfo = function(url, cb){
  try{
    thumbInit();
    thumbClear();
    new GLTFLoader().load(url, function(g){
      var obj = g.scene || g.scenes[0];
      THUMB.holder.add(obj);

      var tri = 0, skinned = false;
      obj.traverse(function(o){
        if (o.isMesh && o.geometry){
          var geo = o.geometry;
          tri += Math.round((geo.index ? geo.index.count
                                       : (geo.attributes.position ? geo.attributes.position.count : 0)) / 3);
        }
        if (o.isSkinnedMesh) skinned = true;
      });

      var anims = ((g && g.animations) || []).map(function(c){
        return { name: c.name || '', dur: Math.round((c.duration || 0) * 100) / 100 };
      });

      var tex = [], seen = {};
      var SLOTS = ['map', 'normalMap', 'metalnessMap', 'roughnessMap', 'emissiveMap', 'aoMap'];
      obj.traverse(function(o){
        var mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
        mats.forEach(function(mm){
          SLOTS.forEach(function(k){
            var t = mm && mm[k];
            if (!t || !t.image || seen[t.uuid]) return;
            seen[t.uuid] = 1;
            tex.push({ slot: k, url: _pv3dTexURL(t.image) });
          });
        });
      });

      thumbClear();
      cb({ tri: tri, anims: anims, skinned: skinned, tex: tex });
    }, undefined, function(){ thumbClear(); cb({ err: '打不开这个 glb' }); });
  }catch(e){
    cb({ err: String(e) });
  }
};

/* ============================================================
   以下这段是「弹层自带的东西」—— **DOM 和样式都由这个单元自己建**。

   为什么：阿聪 2026-10-04 立的规矩 ——「**随便一个 model 单独拿出来都能用**」。
   原来弹层的 HTML 要宿主页面先摆好（网站里摆一份、调试页里又摆一份，还得手动对齐），
   `glbview` 换个宿主就用不了。现在：
     · 宿主**已经有** `#pv3d` → 直接用（网站就是这种，不动它）
     · 宿主**没有** → 这个单元自己建一个挂上去
   样式同理：宿主有就沿用，没有就自己注入（暗色变量都给了默认值，孤独使用也好看）。
   ============================================================ */
var PV3D_CSS = String.raw`
#pv3d{
    --accent:#e8925a; --accent-2:#f0a868; --hair:#ece2d5; --hair-strong:#e0d3c2;
    --text:#3d3833; --dim:#9c938a; --bg:#faf6f0;
  }
  /* 🔴 这个单元要"单独拿走能用"，所以 hidden 的兜底也得自带 ——
     宿主（网站）那边有一条全局 [hidden]{display:none!important}，
     但独立调试台没有 → .pv3d-msg{display:flex} 会把 hidden 属性盖掉，
     表现是「正在加载…」永远收不掉、盖在模型上（2026-10-04 实测抓到）。
     只框在自己身上（#pv3d [hidden]），不去动宿主的全局样式。 */
  #pv3d [hidden]{ display:none !important; }
  .pv3d-body{
    flex:1;
    display:flex;
    gap:14px;
    padding:52px 18px 18px;   /* 上：给绝对定位的头部让位 */
    min-height:0;
  }
  .pv3d-side{
    width:230px; flex:none;
    display:flex; flex-direction:column;
    gap:10px;
    padding-top:4px;
  }
  .pv3d-src{
    display:grid;
    grid-template-columns:1fr 1fr;
    gap:8px;
    align-content:start;
  }
  .pv3d-src img{
    width:100%; aspect-ratio:3 / 4; object-fit:cover;
    border-radius:8px; background:#fff;
    border:1px solid var(--hair);
    box-shadow:0 2px 8px rgba(0,0,0,.06);
  }
  .pv3d-stage{
    flex:1; min-width:0;
    border-radius:12px;
    overflow:hidden;
    background:#f7f3ec;
    position:relative;          /* 给面数那行小字当定位上下文 */
  }
  .pv3d-stage canvas{ display:block; width:100% !important; height:100% !important; }
  /* UV 布局图（平铺那张）：**画布左上角**一块（阿聪 2026-10-13：「只是这次是显示在这里，
     窗口的左上角」）。**只在开「UV 检查」时出现**。
     🔑 它跟模型上看到的是**同一张画布** —— 同一张图，天然一一对应（不是两边各算，
        那种做法试过，追不到完全一致，见进度文档）。 */
  .pv3d-uvmap{
    /* ⚠️ z-index 要比姿态/动画那两块浮层低（它们是 4，也在左上角）——
       两边同时开的时候让它们压在上面，不至于互相盖住看不清。 */
    position:absolute; left:12px; top:12px; z-index:3;
    width:172px; padding:6px 6px 3px;
    background:rgba(255,255,255,.93);
    border:1px solid var(--hair); border-radius:8px;
    box-shadow:0 2px 8px rgba(0,0,0,.10);
    cursor:zoom-in;              /* 点一下看大图（阿聪 2026-10-13：「可大图点击」） */
  }
  .pv3d-uvmap[hidden]{ display:none; }
  .pv3d-uvmap img{ display:block; width:100%; height:auto; border-radius:4px; background:#000; }
  .pv3d-uvmap i{ display:block; margin-top:2px; font-size:10px; font-style:normal;
                 color:#8a8177; text-align:center; }
  /* 点小图弹出来的**大图**：整块盖住画布，点哪儿都关（Esc 也能关）。 */
  .pv3d-uvbig{
    position:absolute; inset:0; z-index:9;
    background:rgba(24,21,18,.74);
    display:flex; align-items:center; justify-content:center;
    cursor:zoom-out;
  }
  .pv3d-uvbig[hidden]{ display:none; }
  .pv3d-uvbig img{
    max-width:88%; max-height:88%; width:auto; height:auto;
    background:#000; border-radius:8px;
    box-shadow:0 10px 34px rgba(0,0,0,.45);
  }
  /* 三角面数：**画布左上角一行小字**（阿聪 2026-10-04 定的样式）——
     在窗口里、无框无底、整行同一个字色、标签放在数字前面。
     （以前在左栏底部，跟「拖动旋转…」挤在一行，他说那样不满意） */
  .pv3d-stat{
    /* ⚠️ 2026-10-06 阿聪让挪的：「**三角面数放右下角**」——
       左上角那格腾出来给姿态模式的操作按钮 + 骨名列表（见下）。 */
    position:absolute; right:16px; bottom:14px; z-index:2;
    margin:0; font-size:12px; color:var(--dim); letter-spacing:.2px;
    pointer-events:none;
  }
  .pv3d-stat b{ font-weight:600; font-variant-numeric:tabular-nums; }
  /* 🆕 2026-10-14「调试」下拉 —— **画布右上角**（阿聪：「模型视图的右上角……加一个调试」）。
     装的是**平时用不上的排查类开关**（现在：显示原点；下一步加"显示面朝向"）。
     从**左栏**挪出来的 —— 左栏留给每一步都会用的常用开关（他截图里的红框就是右上角这块空白）。
     🔴 本段（PV3D_CSS）是 String.raw 模板串，**一个反引号都不许写**（见 .pv3d-posectl 那段）。 */
  .pv3d-dbg{
    position:absolute; right:16px; top:14px; z-index:5;
    font:inherit;
  }
  .pv3d-dbg > summary{
    list-style:none; cursor:pointer; user-select:none;
    display:inline-block; padding:4px 10px;
    font-size:11.5px; color:var(--text);
    border:1px solid var(--hair-strong); border-radius:7px;
    background:rgba(255,255,255,.92);
  }
  .pv3d-dbg > summary::-webkit-details-marker{ display:none; }   /* 去掉浏览器那个三角 */
  .pv3d-dbg > summary:hover{ border-color:var(--accent); }
  /* 展开时按钮自己亮起来 —— 跟旁边那排开关"点开就亮"的手感一致 */
  .pv3d-dbg[open] > summary{ background:var(--accent); border-color:var(--accent); color:#fff; }
  .pv3d-dbg-panel{
    position:absolute; right:0; top:calc(100% + 6px);
    min-width:132px; padding:6px;
    display:flex; flex-direction:column; gap:4px;
    background:rgba(255,255,255,.97);
    border:1px solid var(--hair-strong); border-radius:8px;
    box-shadow:0 4px 16px rgba(0,0,0,.14);
  }
  .pv3d-dbg-item{
    font:inherit; font-size:11.5px; text-align:left; white-space:nowrap; cursor:pointer;
    padding:5px 9px; border-radius:6px;
    border:1px solid transparent; background:transparent; color:var(--text);
  }
  .pv3d-dbg-item:hover{ background:#fff8f2; color:var(--accent); }
  /* ⚠️ 亮起的类名还是 did（不加反引号 —— 这一段是 String.raw 模板串，见上面那条禁令）——
     跟原来左栏那个按钮同一套（见 pv3dOrigin 的事件绑定），所以那边一行都不用改。 */
  .pv3d-dbg-item.did{ background:var(--accent); border-color:var(--accent); color:#fff; }
  /* 姿态模式的操作按钮（画布**右上角**）—— 只在姿态模式下出现。
     🔴 阿聪 2026-10-06：「**glbview 还是专注模型查看吧，就不塞入操作了**」——
        所以这一块**必须由宿主传 opts.poseMode 才出**（目前只有 4.1/4.2 那几步传），
        glbview 自己绝不主动露出来。
     ⚠️⚠️ **上面这句里本来写的是带反引号的 opts.poseMode，结果整个脚本语法错**
        （这段是 String.raw 模板字符串，反引号会把它提前结束 —— 跟下面那条
        .pv3d-bone-lb 的警告是同一个坑，我又踩了一次）。**这类注释里一个反引号都别写。** */
  /* 🎬 动画控件（播放 / 暂停 + 速度）—— 跟姿态模式**同一个位置**（画布左上角）。
     有动作的模型才有它（hidden 由模型加载完那边的回调摘掉）。
     ⚠️ 这段里**一个反引号都不许写**（它本身是 String.raw 模板串）——
        2026-10-06 我又踩了一次，整个脚本语法错、页面全白，见工作方式第十节。 */
  .pv3d-animctl{
    position:absolute; left:16px; top:14px; z-index:4;
  }
  .pv3d-posectl{
    /* ⚠️ 2026-10-06 阿聪让挪的：「**操作之类的放左上角**」。
       ⚠️ 宽度也收过一轮 —— 他原话：「**这个旋转啥的，就是 ui 能改小点吗，
          我点有点不到其他骨骼了**」：面板一大就把画布挡住，模型那半边的骨点不着。
          现在：面板收窄 + 列表**默认只展开第一层**（见 pv3dBoneNode）。
       🔴🔴 **这段（PV3D_CSS）里一个反引号都不许写** —— 它本身是 String.raw 模板字符串，
          再出一个会把字符串**提前结束**、整个脚本语法错、页面直接白。
          2026-10-06 这一天**在同一个地方踩了三次**，所以 build.py 里专门加了一条检查
          （check_pv3d_css），别再靠"记得"。 */
    position:absolute; left:16px; top:14px; z-index:4;
    display:flex; flex-direction:column; gap:5px;
    max-width:148px;
  }
  .pv3d-posebtns{ display:flex; gap:4px; }
  .pv3d-posebtn{
    font:inherit; font-size:11px; cursor:pointer;
    padding:4px 6px; border-radius:7px;
    border:1px solid var(--hair-strong); background:rgba(255,255,255,.92);
    color:var(--text);
  }
  .pv3d-posebtn:hover{ border-color:var(--accent); }
  .pv3d-posebtn.on{ background:var(--accent); border-color:var(--accent); color:#fff; }
  /* 快捷键那个字母 —— W 移动 / E 旋转是 **UE 同款**，R 复位是 Blender 的习惯 */
  .pv3d-posebtn b{ font-weight:700; margin-right:3px; opacity:.75; }
  /* 骨名列表（阿聪 2026-10-06：「操作方式下面，**简单从上到下列出一列骨骼名字**，
     这样可以方便美术点选骨骼」）—— 点一个就选中那根骨，gizmo 跟过去。
     ⚠️ 骨数可能是 20~52 根，所以**得能滚**，不然把画面占满了。 */
  /* 🎨 「权重图」那个按钮 —— **单独一行、占满宽度**，跟上面那排操作按钮分开
     （阿聪 2026-10-06：「在**操作和骨骼中间**，插入一个叫权重图的按钮」）。 */
  .pv3d-wbtn{
    font:inherit; font-size:11px; cursor:pointer; width:100%;
    padding:5px 6px; border-radius:7px;
    border:1px solid var(--hair-strong); background:rgba(255,255,255,.92);
    color:var(--text);
  }
  .pv3d-wbtn:hover{ border-color:var(--accent); }
  .pv3d-wbtn.on{ background:var(--accent); border-color:var(--accent); color:#fff; }

  .pv3d-bonelist{
    /* ⚠️ 高度也压过 —— 它一高就把模型的半边挡了（阿聪：「我点有点不到其他骨骼了」）。
       42vh + **默认只展开第一层**，实际通常就几行。 */
    max-height:42vh; overflow:auto;
    background:rgba(255,255,255,.94);
    border:1px solid var(--hair-strong); border-radius:8px;
    padding:2px;
  }
  .pv3d-bonelist.hid{ display:none; }              /* 整条列表收起来（只留上面那排操作按钮）*/
  /* 一行骨 —— 「箭头（有没有子骨）+ 名字」，**按父子层级缩进**（缩进量在 JS 里给） */
  .pv3d-bonerow{ display:flex; align-items:center; gap:1px; }
  .pv3d-bonetog{
    flex:0 0 auto; width:12px; height:15px; padding:0; cursor:pointer;
    font:inherit; font-size:8px; line-height:1; color:var(--dim);
    border:0; background:transparent; border-radius:3px;
  }
  .pv3d-bonetog:hover{ background:var(--hair); color:var(--text); }
  .pv3d-bonetog.leaf{ visibility:hidden; }        /* 没子骨的，箭头位**留着**，名字才对得齐 */
  .pv3d-bonepick{
    flex:1 1 auto; min-width:0; text-align:left; cursor:pointer;
    font:inherit; font-size:10.5px; color:var(--text);
    padding:1px 4px; border:0; border-radius:4px; background:transparent;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  }
  .pv3d-bonepick:hover{ background:var(--hair); }
  .pv3d-bonepick.on{ background:var(--accent); color:#fff; }
  .pv3d-bonesub.hid{ display:none; }              /* 折起来的那一支 */
  /* 列表顶上那排：**全展 / 全折 / 收起**（阿聪 2026-10-06：「分成全展和全折，
     收起三个按钮」）。三个都靠左排 —— 面板窄，space-between 会把它们推开、
     反而挤。 */
  .pv3d-bonelist-head{
    display:flex; align-items:center; justify-content:flex-start;
    gap:4px; padding:2px 3px 3px; border-bottom:1px solid var(--hair);
    margin-bottom:2px;
  }
  .pv3d-bonelist-head button{
    font:inherit; font-size:10.5px; cursor:pointer; color:var(--text);
    padding:1px 5px; border:1px solid var(--hair-strong); border-radius:5px;
    background:rgba(255,255,255,.9); white-space:nowrap; flex:0 0 auto;
  }
  .pv3d-bonelist-head button:hover{ border-color:var(--accent); }
  /* 骨名的标签（跟着 3D 里的骨头走，每帧用投影算屏幕位置）——
     绝对定位在画布里，位置（transform）由 JS 每帧改。
     ⚠️ **这一段（PV3D_CSS）里一个字都别写反引号** —— 它本身是 String.raw 模板字符串，
        里面再出一个会直接**把字符串提前结束** → 整个脚本报语法错、页面直接白
        （2026-10-06 踩过：控制台只说 Unexpected identifier，很难往这儿想）。 */
  .pv3d-bone-lb{
    position:absolute; left:0; top:0; z-index:3;
    padding:1px 4px; border-radius:4px;
    background:rgba(255,255,255,.86); color:#8a4b1e;
    font-size:10px; line-height:1.35; white-space:nowrap;
    pointer-events:none; font-variant-numeric:tabular-nums;
    box-shadow:0 1px 2px rgba(0,0,0,.10);
  }
  .pv3d-tip{
    margin:0; font-size:11.5px; line-height:1.7; color:var(--dim);
  }
  #pv3d{
    position:fixed; inset:0; z-index:60;
    background:rgba(40,32,26,.55);
    display:flex; align-items:center; justify-content:center;
  }
  #pv3d[hidden]{ display:none !important; }
  .pv3d-box{
    /* 比原来宽 —— 左边那栏要放得下四视图（230px）+ 右边还要有像样的 3D 画面 */
    position:relative;
    display:flex; flex-direction:column;
    width:min(90vw, 1120px); height:min(86vh, 780px);
    background:#fbf7f1;
    border-radius:16px;
    box-shadow:0 24px 60px rgba(0,0,0,.28);
    overflow:hidden;
  }
  .pv3d-box canvas{ display:block; }
  .pv3d-head{
    position:absolute; left:0; right:0; top:0;
    display:flex; align-items:center; gap:10px;
    padding:12px 16px;
    font-size:12.5px; color:var(--text);
    background:linear-gradient(#fbf7f1, rgba(251,247,241,0));
    pointer-events:none;
  }
  .pv3d-head b{ flex:1; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .pv3d-fit{
    font:inherit; font-size:13px;
    padding:9px 12px;
    width:100%;
    border:1px solid var(--hair); border-radius:10px;
    background:#fff; color:var(--text); cursor:pointer;
    transition:all .15s;
  }
  .pv3d-fit:hover{ border-color:var(--accent-2); color:var(--accent); background:#fff8f2; }
  .pv3d-fit:active{ transform:scale(.98); }
  .pv3d-fit.did{ background:var(--accent); border-color:transparent; color:#fff; }
  /* 这步用不上的按钮（比如还没展 UV 就点不了「UV 检查」）—— 灰着，但不藏
     （阿聪 2026-10-04：「由始至终用这套」，每步的界面长得一样） */
  .pv3d-fit:disabled{ opacity:.42; cursor:not-allowed; }
  .pv3d-fit:disabled:hover{ border-color:var(--hair); color:var(--text); background:#fff; }
  /* 「法线 / AO」那种**一张卡两种看法**的按钮：中间竖一条线劈成两半，点哪半用哪种
     （阿聪 2026-10-05：「中间竖一条线，相当于分割成两个区域，左边是纯法线，
     右边是法线效果」）。
     ⚠️ 已经亮着的那半**再点一下 = 取消**（两半都不亮 = 这个效果关掉了）。 */
  .pv3d-split{ display:flex; padding:0; overflow:hidden; }
  .pv3d-split .pv3d-half{
    flex:1; padding:9px 4px; font-size:12.5px; text-align:center; line-height:1.5;
    color:var(--text); cursor:pointer; transition:all .15s; white-space:nowrap;
  }
  .pv3d-split .pv3d-half + .pv3d-half{ border-left:1px solid var(--hair); }
  .pv3d-split .pv3d-half:hover{ background:#fff8f2; color:var(--accent); }
  .pv3d-split .pv3d-half.on{ background:var(--accent); color:#fff; font-weight:700; }
  .pv3d-close{
    pointer-events:auto;
    flex:none;
    width:26px; height:26px;
    border:1px solid var(--hair-strong); border-radius:50%;
    background:#fff; color:var(--text);
    font-family:inherit; font-size:14px; line-height:1;
    cursor:pointer;
  }
  .pv3d-close:hover{ border-color:var(--accent); color:#8a4b1e; }
  .pv3d-msg{
    position:absolute; inset:0;
    display:flex; align-items:center; justify-content:center;
    font-size:12.5px; color:var(--dim);
  }
`;

var PV3D_HTML = '<div class="pv3d-box">' +
  '<div class="pv3d-head"><b id="pv3dName"></b>' +
    '<button class="pv3d-close" id="pv3dClose" title="关掉">&#215;</button></div>' +
  '<div class="pv3d-body">' +
    '<div class="pv3d-msg" id="pv3dMsg">正在加载…</div>' +
    /* 🔴 **这几个开关的上下顺序 = 能力解锁的先后**（阿聪 2026-10-06：
       「其实就是我们的**步骤顺序和解锁能力顺序**」）——
       布线（建模就有）→ UV（2.3 展了 UV）→ 法线（3.1 烘了才有）→
       骨架（4.1 绑了骨才有）。**加新开关时按这个插，别按写的先后**。 */
    '<div class="pv3d-side">' +
      '<div class="pv3d-src" id="pv3dSrc" hidden></div>' +
      '<button class="pv3d-fit" id="pv3dFit" title="把镜头拉回默认视角">&#10227; 复位视角</button>' +
      /* 🆕 2026-10-14「显示原点」**原来在这儿**（阿聪 当时指名的位置：紧挨复位视角下面）。
         2026-10-15 搬到**画布右上角那个「调试」下拉**里了 ——
         阿聪：「模型视图的右上角……加一个调试……把左栏那个「显示原点」收进来」，
         规矩是**同一个功能不留两个入口**（留两个早晚对不上）。见下面 .pv3d-dbg 那块 HTML。 */
      /* 🆕 2026-10-14：**「白模」**（阿聪 ：「在**复位视角**下面和**显示布线**上面搞一个白模…
         点一下它就是纯白膜了」）—— 把贴图**全摘掉**、底色刷白，只剩几何 + 光照。
         用途：2.2 重拓扑出来的产出上有"**奇怪的阴影**"，要分清是**贴图里烘的**还是
         **模型自己的法线 / 几何**的问题 —— 白模一眼分出来。
         ⚠️ 它是**每步都能点**的（不像 UV / 法线那样按能力灰）。
         ⚠️ 位置是阿聪 **指名的**，没按"能力解锁顺序"那条规矩走（那条见上面）。 */
      '<button class="pv3d-fit" id="pv3dWhite" title="把贴图全摘掉，只看纯白几何 —— 一眼分清阴影是贴图带来的、还是模型本身的问题">&#9634; 白模</button>' +
      '<button class="pv3d-fit" id="pv3dWire" title="在模型上盖一层线，看清布线">&#9638; 显示布线</button>' +
      '<button class="pv3d-fit" id="pv3dUV" title="给模型换上 UV 检查色块，看 UV 展得匀不匀">&#9636; UV 检查</button>' +
      /* 法线 —— **只有 3.1 烘出来的模型才有**这张贴图（阿聪 2026-10-05：
         「我测到 3.1 了嘛，我想看看法线效果和 AO 效果」）。
         跟 UV 检查一样：**一直在、别的步灰着**。
         一张卡**两种看法**（左：贴图本身 / 右：把它关掉看裸模型）——
         阿聪 2026-10-05：「中间竖一条线，相当于分割成两个区域」。
         ⚠️ AO 那排 2026-10-06 撤了（阿聪：「ao 算了」）。 */
      /* ⚠️ `title` 不写在这儿 —— 写在 `pv3dOpen` 里（能用的步和不能用的步文案不一样），
         一处就够，免得两处对不上 */
      /* 🆕 2026-10-15：原来这里是一张**两格卡**（纯法线 ｜ 关掉法线），阿聪 让**拆开** ——
         「**关掉法线**呢直接放进调试里吧，然后**纯法线**呢就继续留在左栏」。
         所以左栏只剩「纯法线」这一个按钮（形态、位置跟旁边那排一样，不会缺块）；
         「关掉法线」去了下面那个「⚙ 调试」下拉里。
         🔑 **语义没变**：一次最多亮一个，再点亮着那个 = 回"模型原样"（见 `pv3dBindBakeOne`）。 */
      '<button class="pv3d-fit" id="pv3dNormalRaw">纯法线</button>' +
      /* 显示骨架 —— **4.1 绑了骨才有**，所以排在法线下面（见上面那条顺序的规矩）。
         ⚠️ 这里**写死 `disabled`**：能不能点要看**这个模型自己有没有骨头**，
           得模型加载完才知道（判据见 `pv3dOpen` 的回调，不在这儿）。
           `title` 也那儿写 —— 有骨/没骨两套文案不一样。 */
      /* 骨架 —— 跟法线那张**一个形态**（阿聪 2026-10-06：「显示骨架和显示骨名
         **本质是同一模块的**，所以像法线并在一起吧」）：一张卡劈两半，
         **一次只看一个，两格都不亮 = 不画骨架**。
           · 左「显示骨架」= 画骨头（关节球 + 连线）
           · 右「显示骨名」= 画骨头 **+ 每根标上名字**（52 根骨全摊会糊，
             平时看位置够左格，要核**骨名对不对**（接引擎那步）才用右格）
         判据：**模型自己有没有骨头**；这里先写死 `disabled`，加载完再放开。 */
      '<button class="pv3d-fit pv3d-split" id="pv3dSkel" disabled>' +
        '<span class="pv3d-half" data-m="bone">显示骨架</span>' +
        '<span class="pv3d-half" data-m="name">显示骨名</span>' +
      '</button>' +
      /* 🦴 拖动骨骼 —— 排在骨架下面（**蒙完皮才谈得上拖**，那是 4.2 的事）。
         阿聪 2026-10-06：「**能不能让模型跟着骨骼动一动**……像 blender 那样，
         这个单元页蒙完皮，还能让我拖动骨骼动一动，**看看蒙皮质量如何**」。
         🔑 为什么值得做：**蒙皮的毛病只有把关节转起来才看得见** ——
            candy wrapper（关节一扭转那圈像糖纸一样往里缩）、体积丢失、权重泄漏，
            这三样光读文件查不出来（静态那几项只能查"绑没绑上"）。
         形态跟旁边两张一样是**两格卡**：左「转关节」/ 右「拖位置」，
         两格都不亮 = 关掉（**同时把姿势还原**）。
         判据跟骨架一样看**模型自己有没有骨头**；先写死 `disabled`，加载完再放开。 */
      /* 🦴 姿态模式 —— **一个总开关**（阿聪 2026-10-06：「skin 这个单元页不搞这个
         什么拖骨骼移骨骼按钮了，直接搞一个总按钮叫**姿态模式**，这个时候骨骼才可动」）。
         开着 = 骨骼可点选、可拖；操作按钮（旋转/移动 + UE 快捷键）浮在**画布右上角**。
         ⚠️ 跟其他开关不一样：**这个入口只在宿主传了 `opts.poseMode` 时才出现**
            （4.2 那一步才传）—— 因为阿聪说了「**glbview 还是专注模型查看吧，
            就不塞入操作了**」。没传的话它一直 `hidden`，别的步看不到。 */
      '<button class="pv3d-fit" id="pv3dPose" hidden>&#9881; 姿态模式</button>' +
      /* 🎞 动画模式 —— 跟「姿态模式」**同一个形态的总开关**，就排在它下面（阿聪 2026-10-06：
         「我是想在**姿态模式下面加个动画模式**，然后左上角那些是**动画模式才出现**，
          就跟姿态模式才出现操作按键一样」）。
         ⚠️ 跟姿态模式的区别：**有动作的模型才露出来**（判据是模型自己带没带
            `animations`，要等加载完才知道 → 这儿先写死 `hidden`，回调里再放开）。 */
      '<button class="pv3d-fit" id="pv3dAnimMode" hidden>&#8635; 动画模式</button>' +
      /* 🎨 「权重图」**不在左栏** —— 阿聪 2026-10-06：「**在操作和骨骼中间，插入一个
         叫权重图的按钮，这样就不在左侧加按钮了**」。
         它是**姿态模式那套工具里的一件**（拖骨头 + 看权重，同一摊事），
         所以放在浮层里、操作按钮下面。见 `#pv3dWeight`。 */
      /* ⚠️ 「播放动画」+「播放速度」**2026-10-06 从左栏搬到画布左上角**了
         （阿聪：「**不是在左侧加按钮**……我想按钮**像姿态模式的骨骼架构操作方式**之类的，
         直接放在**视图左上角**，**只有动画模式才有这个**」）——
         见下面 `pv3d-stage` 里的 `#pv3dAnimctl`。这里不再有它们。 */
      // 面数：左栏一行小字（阿聪 2026-10-04 圈的就是这块空白）
      '<p class="pv3d-tip" id="pv3dTip">拖动旋转 · 滚轮缩放 · 双击画面也能复位</p>' +
    '</div>' +
    '<div class="pv3d-stage" id="pv3dStage">' +
      /* 🆕 2026-10-15「调试」下拉 —— **画布右上角**（阿聪：「模型视图的右上角……加一个调试」；
         他截图里红框就是这块空白，**不是左栏**）。
         装**平时用不上的排查类开关** —— 左栏留给每一步都会用的常用开关。
         现在里面只有一项「显示原点」（从**左栏搬过来**的，同一个功能不留两个入口）；
         下一步再加「显示面朝向」。开新项就往 .pv3d-dbg-panel 里加一个 button。
         ⚠️ 原生 details/summary，不用 JS 就能展开收起（点面板外收起那几行在下面的事件绑定区）。 */
      '<details class="pv3d-dbg" id="pv3dDbg">' +
        '<summary title="排查用的小开关">&#9881; 调试</summary>' +
        '<div class="pv3d-dbg-panel">' +
          /* 「显示原点」—— id 还是 pv3dOrigin，所以下面那两处（事件绑定 / 打开时归位）
             一行都不用改，只是换了件"外套"（.pv3d-fit -> .pv3d-dbg-item）。
             亮起的类名照旧是 `did`（样式见上面 .pv3d-dbg-item.did）。 */
          '<button class="pv3d-dbg-item" id="pv3dOrigin" title="在模型的原点上画 XYZ 三轴（红 = X · 绿 = Y · 蓝 = Z，箭头指正方向）">显示原点</button>' +
          /* 🆕 2026-10-15「显示面朝向」—— **正面蓝、背面红**，一眼看出哪些面朝向反了
             （法线朝内）。为什么加它、怎么画的，见下面 `pv3dApplyFacing` 那段。 */
          '<button class="pv3d-dbg-item" id="pv3dFacing" title="正面蓝 / 背面红 —— 一眼看出哪些面朝向反了（法线朝内）">显示面朝向</button>' +
          /* 🆕 2026-10-15「平面着色」—— **默认开**（阿聪：「以后这个 glbview 显示呢都是平面着色」）。
             为什么放这儿不放左栏：它跟「显示原点」「显示面朝向」是**同一类**（看几何真身的工具），
             而且它**默认开着** —— 左栏留给"每一步都会用的常用开关"。见下面 `pv3dApplyFlat`。 */
          '<button class="pv3d-dbg-item" id="pv3dFlat" title="无视顶点法线、一个面一个平色 —— 看几何的真身（不被自带的法线数据骗）">平面着色</button>' +
          /* 🆕 2026-10-15「自动平滑」—— **默认开**（阿聪：「以后**默认开自动平滑**」）。
             干什么见下面 `pv3dApplyAutoSmooth`（就是 Blender 那个自动平滑的语义）。
             ⚠️ 它跟「平面着色」**不用互斥**：一个改顶点法线、一个设 flatShading，
                平面着色开着时自动平滑"看着没效果"属正常，平面着色一关它立刻回来。 */
          '<button class="pv3d-dbg-item" id="pv3dSmooth" title="按面与面的夹角分：小角的平滑、大角的留硬边 —— 就是 Blender 那个自动平滑（再点一下关掉，回全平滑）">自动平滑</button>' +
          /* 🆕 2026-10-15：**「关掉法线」是从左边栏搬进来的**（阿聪：「关掉法线呢直接放进调试里吧，
             然后纯法线呢就继续留在左栏」）—— 左栏那张两格卡因此拆开了，左边现在只有「纯法线」。
             ⚠️ 高亮/点击都跟「纯法线」共用同一套（见 `pv3dMarkBakeBtns` / `pv3dBindBakeOne`）。 */
          '<button class="pv3d-dbg-item" id="pv3dNormalOff" title="关掉法线">关掉法线</button>' +
        '</div>' +
      '</details>' +
      // 三角面数：**画布左上角一行小字**（样式见上面 PV3D_CSS 里的 .pv3d-stat）
      '<p class="pv3d-stat">三角面 <b id="pv3dTri">&mdash;</b></p>' +
      /* UV 布局图（平铺那张）：**画布左上角**那块。**只在开「UV 检查」时出现**，
         点了弹大图。内容就是 pv3dMakeUVChecker 画的那张画布本身 —— 见 pv3dShowUVMap()。 */
      '<div class="pv3d-uvmap" id="pv3dUvmap" hidden title="点一下看大图">' +
        '<img id="pv3dUvmapImg" alt="UV 布局图">' +
        '<i>UV 布局图</i>' +
      '</div>' +
      '<div class="pv3d-uvbig" id="pv3dUvBig" hidden><img id="pv3dUvBigImg" alt="UV 布局图"></div>' +
      /* 姿态模式的操作按钮 —— 就在**画布右上角**（阿聪：「图片红框处就会出现
         操作按钮，旋转和移动，然后附上快捷键，可以直接用 ue 的同款快捷键」）。
         W = 移动、E = 旋转（UE 视口就是这两个，肌肉记忆能直接带过来）。
         默认 `hidden`，进了姿态模式才放出来。 */
      /* 🎬 「动画模式」的控件 —— **有动作的模型才有**（阿聪 2026-10-06：
         「**不是在左侧加按钮**……我想按钮**像姿态模式的骨骼架构操作方式**之类的，
         直接放在**视图左上角**，**只有动画模式才有这个**，然后再加个播放动画和
         暂停动画的按钮，也是视图左上角」）。
         ⚠️ 跟姿态模式浮层**都在左上角** —— 两个同时开时，由 `pv3dLayoutAnimCtl()`
            把这一块往下让（姿态那块高度不固定：骨名列表能折叠，纯 CSS 算不出来）。
         ⚠️ 按钮用的就是 `.pv3d-posebtn` **同一套样式**，没自造控件。 */
      '<div class="pv3d-animctl" id="pv3dAnimctl" hidden>' +
        '<div class="pv3d-posebtns">' +
          '<button class="pv3d-posebtn" id="pv3dAnim">&#9654; 播放</button>' +
          '<button class="pv3d-posebtn pv3d-spd" data-s="0.5">0.5&times;</button>' +
          '<button class="pv3d-posebtn pv3d-spd on" data-s="1">1&times;</button>' +
          '<button class="pv3d-posebtn pv3d-spd" data-s="2">2&times;</button>' +
        '</div>' +
        /* 🎞 动作切换 —— 模型带**多段**动作时才露出来（4.3 现在一次出 3 段：
           待机 / 走路 / 跑步）。按钮**按模型自己的 animations 动态生成**，
           不写死三个 —— 以后换了动作库、段数变了也不用改这儿。 */
        '<div class="pv3d-posebtns" id="pv3dActBtns" hidden></div>' +
      '</div>' +
      '<div class="pv3d-posectl" id="pv3dPosectl" hidden>' +
        /* 三个操作键。⚠️ **顺序是阿聪定的**（2026-10-06）：
           「**W 移动在左，E 旋转在右，符合键盘逻辑**，复位姿势可以给个 **R 键**」——
           键盘上 W 就在 E 左边，所以按钮也照这个排。 */
        '<div class="pv3d-posebtns">' +
          '<button class="pv3d-posebtn" data-tool="move"><b>W</b>移动</button>' +
          '<button class="pv3d-posebtn on" data-tool="rotate"><b>E</b>旋转</button>' +
          /* 🔄 复位姿势 —— 拖乱了想回到最初的样子（阿聪：「姿态模式还得有**复位键**，
             回到最初的样子」），快捷键 **R**。
             ⚠️ 跟**退出**的区别：这个**不退出模式**，复位完还能接着拖；
                退出去会把记下的原始姿势也清掉（那是另一条路，`pv3dPoseRestore`）。
             ⚠️ 也跟左栏「复位视角」不是一回事 —— 那个复位的是**相机**，这个是**姿势**。 */
          '<button class="pv3d-posebtn" data-tool="reset"><b>R</b>复位</button>' +
        '</div>' +
        /* 🎨 权重图 —— 阿聪 2026-10-06：「**在操作和骨骼中间，插入一个叫权重图的按钮**」。
           挑一根骨 → 整个模型按"这个顶点被这根骨影响多少"着色
           （蓝 0 → 青 .25 → 绿 .5 → 黄 .75 → 红 1，跟 Blender 的权重绘色一致）。
           🔑 **看蒙皮质量最直接的一把尺子**：哪儿该红没红（没绑上）、哪儿串色了，一眼可见。
           ⚠️ 它**跟姿态模式共用那排浮层** → 退出姿态模式时一并关掉（见 `pv3dSetPose`）。 */
        '<button class="pv3d-wbtn" id="pv3dWeight">&#127912; 权重图</button>' +
        /* 骨名列表 —— 阿聪 2026-10-06：「操作方式下面，**简单从上到下列出一列骨骼名字**，
           这样可以方便美术点选骨骼」。进姿态模式时填一次，点一项 = 选中那根骨。 */
        '<div class="pv3d-bonelist" id="pv3dBoneList"></div>' +
      '</div>' +
    '</div>' +
  '</div></div>';

/* 宿主没给弹层就自己建（DOM + 样式一起）—— 建完返回那个元素 */
function pv3dEnsurePanel(){
  var el = document.getElementById('pv3d');
  if (el) return el;                       // 宿主有 → 直接用，别插手
  if (!document.getElementById('pv3d-selfcss')){
    var st = document.createElement('style');
    st.id = 'pv3d-selfcss';
    st.textContent = PV3D_CSS;
    document.head.appendChild(st);
  }
  el = document.createElement('div');
  el.id = 'pv3d';
  el.hidden = true;
  el.innerHTML = PV3D_HTML;
  document.body.appendChild(el);
  return el;
}

/* 🔴 顺序很重要：**必须在 PV3D_CSS / PV3D_HTML 赋值之后**才能建弹层，
   否则拿到的是空壳（见上面那段注释里记的坑） */
var pv3d = pv3dEnsurePanel();    // 宿主给了就用，没给就自己建一个
pv3dBindUVMapClicks();           // 左上角那块 UV 布局图：点了弹大图（元素刚建出来才绑得上）
var msg = document.getElementById('pv3dMsg');
var nameEl = document.getElementById('pv3dName');

/* ---------- 弹层左侧那两样（阿聪 2026-10-04）----------
     ① 显示**真实**三角面数 —— 数出来的，不是挡位名（「3 万面」那是他选的目标）
     ② 「显示布线」开关 —— ⚠️ 是**在模型上盖一层线**（面照常显示），
        不是 `material.wireframe = true`（那会把面去掉、只剩骨架，看不出"布线"）

   两者都是"看模型"的事，所以归 glbview 管。 */
var pv3dObj = null;      // 弹层里当前那个模型（切布线要拿它）
var wireOn = false;      // 布线模式开着没
/* 动画（4.3 套上动作的产出才有）—— 默认**停着**，要手动点「播放动画」。
   见 `pv3dAnim` 那个按钮上面的注释：不播的话 4.3 等于没打通。 */
var pv3dMixer = null;
var pv3dClock = null;
var pv3dAnimOn = false;
/* 🎞 **动画模式**（总开关）—— 跟「姿态模式」一个意思：
   开着，画布左上角那套控件才露出来（播放 / 速度 / 动作切换）。
   ⚠️ **别跟 `pv3dAnimOn` 搞混** —— 那个是"**正在播 / 暂停**"，
      这个是"**进没进动画模式**"。两个独立：进了模式可以停着，退出去就收摊。
   ⚠️ 退出模式时**顺手停播**（跟姿态模式退出会还原姿势是一个道理）。 */
var animModeOn = false;
/* 打开模型时**先不套动画**：true = 渲染循环跳过 `mixer.update()`，
   骨架停在模型自带的姿势上。点「播放」才置 false、让动画接管。
   （别把它跟 `pv3dAnimOn` 搞混：那个是"正在播 / 暂停"。） */
var pv3dRestMode = false;
var pv3dAnimSpeed = 1;   // 播放速度（倍速）—— 0.5 / 1 / 2，见 `pv3dAnimctl` 那块浮层。
                         // ⚠️ **不跟着模型重置**：选过 2× 就一直 2×（换个模型也保持）。
var pv3dClipN = 0;       // 这个模型带几段动作（0 = 没有）
var pv3dClips = [];      // 模型里那几段动作（`g.animations`）—— 给"动作切换"用
var pv3dClipIdx = 0;     // 现在播的是第几段

/* 动作段名 → 给人看的短标签。认不出**返回空串**，调用处退回显示原名。 */
/* 🔴 2026-10-14 扩的：原来只有 `idle`/`walk`/`run` 三个词，于是 4.3 的 Mixamo 那条
   一次出多段之后，像 `Loop_jump` / `Loop_wave` 一律认不出 → 按钮上写着「动作 4」，
   一眼看不出这是个什么动作。补几个常用的（子串匹配，**表里顺序就是优先级**）。 */
var PV3D_CLIP_LABELS = [
  ['idle', '待机'], ['walk', '走路'], ['run', '跑步'],
  ['jump', '跳跃'], ['wave', '挥手'], ['dance', '跳舞'],
  ['sit', '坐下'], ['attack', '攻击'], ['hit', '受击'], ['death', '倒地'],
  /* 🆕 2026-10-15：跟 `mixamo_browser.py` 的 `MOTION_PRESETS` 里的 `id` 对齐
     （那边 `{"id":"look"}` → 动画名叫 `Loop_look`，这儿就认 `look`）。 */
  ['look', '左右探头']
];
function pv3dClipLabel(n){
  var s = String(n || '').toLowerCase();
  for (var i = 0; i < PV3D_CLIP_LABELS.length; i++){
    if (s.indexOf(PV3D_CLIP_LABELS[i][0]) >= 0) return PV3D_CLIP_LABELS[i][1];
  }
  return '';
}

/* 段名的"人话版" —— 认不出中文标签时兜底用（**别显示成「动作 4」**，那等于没说）。
   去掉几种见过的前缀 / 分隔符：
     `Loop_idle`                  -> `idle`      （我们自己的命名，见 fbx2glb_multi.py）
     `Armature|mixamo.com|Layer0`  -> `Layer0`    （Mixamo FBX 的原始 take 名，没改到名时兜底） */
function pv3dClipNiceName(n){
  var s = String(n || '').trim();
  s = s.replace(/^Loop[_-]?/i, '');
  var parts = s.split('|').filter(function(x){ return x.trim(); });
  if (parts.length) s = parts[parts.length - 1];
  return s.trim() || '未命名';
}

function pv3dCountTri(obj){
  var n = 0;
  obj.traverse(function(o){
    if (o.isMesh && o.geometry){
      var g = o.geometry;
      n += Math.round((g.index ? g.index.count
                              : (g.attributes.position ? g.attributes.position.count : 0)) / 3);
    }
  });
  return n;
}

function pv3dApplyWire(){
  if (!pv3dObj) return;
  // 先清掉上次盖的线（每切一次都重新生成，避免叠好几层）
  var old = [];
  pv3dObj.traverse(function(o){ if (o.userData && o.userData.__wire) old.push(o); });
  old.forEach(function(o){
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  if (!wireOn) return;
  // 再给每个 mesh 盖一层：普通网格挂成它的子节点，跟着它一起转
  //
  // 🔴 **蒙皮网格要单独处理**（2026-10-27 实测）：线框不吃骨骼，
  //    挂在蒙皮网格下面只会跟着它那一层的**局部**变换跑 ——
  //    FBX 转出来的模型常常是「骨架 ×0.01、网格 ×100」两层缩放，
  //    于是线框被画到别的位置（看着像"下面又多了一具模型"）。
  //    👉 蒙皮的那种把**世界变换**抄过来、挂到根上，位置就严丝合缝了。
  //    ⚠️ 代价：模型播动画时线框不跟着动（它只认绑定姿势），
  //       但看布线本来就是看静态的，够用。
  pv3dObj.traverse(function(o){
    if (!o.isMesh || !o.geometry) return;
    /* 蒙皮网格：**复制一份、换成线框材质**。
       不能用 WireframeGeometry 那种"画线"的办法 —— 线不吃骨骼，
       只能拿到几何体的原始坐标，蒙皮一变位置就全歪（FBX 转出来的尤其明显）。
       复制出来的 SkinnedMesh 共享同一套骨骼，顶点跟着骨头走，线就贴在皮上。 */
    if (o.isSkinnedMesh){
      var w = o.clone();
      w.material = new THREE.MeshBasicMaterial({
        color: 0x3d3833, wireframe: true, transparent: true, opacity: 0.28,
        depthWrite: false,
      });
      w.userData.__wire = true;
      o.parent.add(w);
      return;
    }
    var l = new THREE.LineSegments(
      new THREE.WireframeGeometry(o.geometry),
      new THREE.LineBasicMaterial({ color: 0x3d3833, transparent: true, opacity: 0.28 }));
    l.userData.__wire = true;
    o.add(l);
  });
}

/* ---------- 「显示原点」开关（阿聪 2026-10-14）----------
   干什么：在**模型的原点**上画 XYZ 三轴 —— 照 Blender 的习惯
   **红 = X · 绿 = Y · 蓝 = Z**，每根轴 = 一条线 + 一个箭头（箭头指**正方向**）。

   为什么要它：原点摆正那件事（2.2 / 2.1 把模型原点摆到脚底）一直
   **只能靠量数字 / 猜** —— 界面上看不见。这个开关把它画出来，
   "原点到底落在哪、Y 朝哪边"一眼就有。

   三条画法上的决定：
   ① 位置取**模型自己的原点**，不是场景原点 —— 模型根节点带平移 / 旋转 / 缩放时，
      它的原点就不在世界原点上（跟 `pv3dModelBox` 一样，得**算世界坐标**再画）。
   ② 轴**朝世界方向**（不跟着模型的本地旋转转）—— 它是个"参考系"：
      模型自己带旋转时，更要能看出"原点在哪、哪边是 +Y"。
   ③ ⚠️ **挂 `scene`、不挂模型** —— 挂模型下面会**继承它的缩放**：
      Mixamo 那类 glb 根节点带 `scale=0.01`，轴会缩成看不见
      （跟关节球那个 bug 同款，见 `pv3dApplySkel` 里那段注释）。
      挂 scene + 长度按**世界空间**尺寸算，就跟模型的缩放无关了。

   材质 `depthTest:false` —— 原点常常落在**身体里 / 脚底**，不穿透就等于看不见
   （跟骨架同一个道理）。
   ⚠️ 它**不抢材质槽**（只是往场景里加一组轴），所以跟白模 / UV / 法线**互不干扰**，
      不像那三个要"排队收"。 */
var originOn = false;      // 「显示原点」开着没

/* 模型的原点（世界坐标）—— glb 的**根节点**才是"模型自己"那一层；
   `gltf.scene` 只是个 identity 的壳（它的原点是世界原点，不是模型的原点）。
   ⚠️ 根节点不止一个时（罕见）退回壳那一层 —— 那种模型本来就没有单一的"原点"。 */
function pv3dModelOrigin(){
  if (!pv3dObj) return null;
  pv3dObj.updateMatrixWorld(true);
  var roots = pv3dObj.children.filter(function(c){ return c && c.isObject3D; });
  var node = (roots.length === 1) ? roots[0] : pv3dObj;
  return node.getWorldPosition(new THREE.Vector3());
}

function pv3dApplyOrigin(){
  if (typeof scene === 'undefined' || !scene) return;
  // 先清掉上次那组（跟「显示布线」一个套路：每切一次重画，别叠层）
  var old = [];
  scene.traverse(function(o){ if (o.userData && o.userData.__origin) old.push(o); });
  old.forEach(function(o){
    if (o.parent) o.parent.remove(o);
    o.traverse(function(c){ if (c.geometry) c.geometry.dispose(); });
    if (o.material) o.material.dispose();
  });
  if (!originOn || !pv3dObj) return;

  var org = pv3dModelOrigin();
  if (!org) return;
  /* 轴多长 —— 按**模型自己有多大**定，别写死（高模矮模差几十倍）。
     取包围盒最长边（跟 `frame()` 同一把尺子）。 */
  var bb = pv3dModelBox(pv3dObj);
  var size = bb.isEmpty() ? new THREE.Vector3(1, 1, 1) : bb.getSize(new THREE.Vector3());
  var maxDim = Math.max(size.x, size.y, size.z) || 1;
  var len = maxDim * 0.22;                       // ≈ 1/4 个模型高（Blender 那个比例）
  var headL = len * 0.26, headW = len * 0.1;     // 箭头：长 / 底半径

  var g = new THREE.Group();
  g.userData.__origin = true;
  g.position.copy(org);                          // 画在**模型的原点**上
  /* 红 X / 绿 Y / 蓝 Z（跟 Blender 一致） */
  [[1, 0, 0, 0xff3b30], [0, 1, 0, 0x2fbf4f], [0, 0, 1, 0x2f6bff]].forEach(function(a){
    var arr = new THREE.ArrowHelper(new THREE.Vector3(a[0], a[1], a[2]),
                                    new THREE.Vector3(0, 0, 0), len, a[3], headL, headW);
    /* 穿透显示（跟骨架同一个道理）：不然长在身体里 / 被脚底挡着那半截看不见。
       `renderOrder` 拉高 → 画在网格**之后**，配 `depthTest:false` 才真盖在上面。 */
    arr.line.material.depthTest = false;
    arr.cone.material.depthTest = false;
    arr.line.renderOrder = 997;
    arr.cone.renderOrder = 997;
    g.add(arr);
  });
  scene.add(g);
}

/* ---------- 「显示面朝向」（阿聪 2026-10-15）----------
   干什么：**正面蓝、背面红** —— 一眼看出**哪些面朝向反了**（法线朝内）。

   为什么要它：2.2 云端 Tripo 出来的低模**本来有"部分面朝里"的毛病** ——
   原来靠后处理「重算成统一朝外」治，**那步被砍了**（阿聪 拍板"只留摆正"）→
   现在**只能靠眼睛查**（阿聪：「**我要亲眼看到事实才能做改动**」）。

   三条画法上的决定：
   ① **选的是"正面/背面异色"**，不是"按法线方向染色（RGB = 法线 xyz）"：
      那个看的是**方向**，可法线本来就四面八方，一眼分不出"这个反了"；
      异色才是一眼可见的。
   ② `side = DoubleSide` —— 不然背面被**剔除**、直接消失，什么都看不到。
   ③ 往 fragment shader 里塞一句 `gl_FragColor = gl_FrontFacing ? 蓝 : 红`。
      `gl_FrontFacing` 是渲染器**本来就用来分正反面**的那个量（按三角形绕序判）——
      **面朝里的片，从外面看就是"背面"** → 变红，跟"渲染出来会怎样"完全一致。
      ⚠️ 直接盖 `gl_FragColor` → **不受光照 / 贴图影响**（白模、UV 检查开着也不干扰读数）。

   ⚠️ 跟「白模」「UV 检查」「法线」**不抢槽**（那三个改贴图，这个改 `side` + shader）——
      同时开着时**以这个颜色为准**（正是想要的：它盖住一切，好看清朝向）。
   ⚠️ 快照单独一套（`__facingSaved`）：只存 `side` 和 `onBeforeCompile` 两样 —— 关掉时精确还原。
   ⚠️ `gl_FragColor` 那两句是在 **main 的最后一个 `}` 之前**插的（不是按某个 include 名找）——
      这样**跟 Three 的版本无关**（chunk 名改过好几轮，写死一个名字早晚会失效）。 */
var facingOn = false;

function pv3dApplyFacing(){
  if (!pv3dObj || typeof pv3dObj.traverse !== 'function') return;
  /* 🔵 **蓝 = 正面（正常）**｜🔴 **红 = 背面（不正常）** ——
     阿聪 2026-10-15 改的配色（原来绿/红，他说「**这个面朝向太难看了，换成那个。红蓝的。
     蓝色就代表正常，红色的是不正常**」）。蓝取的是**中等饱和**那档，跟界面那套暖色调
     摆一起不刺眼；红沿用原来那个（醒目但不过曝）。 */
  var INJ = 'gl_FragColor = gl_FrontFacing ? vec4(0.26,0.52,0.86,1.0) : vec4(0.95,0.30,0.24,1.0);';
  pv3dObj.traverse(function(o){
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(mat){
      if (mat.userData.__facingSaved === undefined){
        mat.userData.__facingSaved = { side: mat.side, obc: mat.onBeforeCompile };
      }
      var s = mat.userData.__facingSaved;
      if (facingOn){
        mat.side = THREE.DoubleSide;
        mat.onBeforeCompile = function(sh){
          var k = sh.fragmentShader.lastIndexOf('}');    // main 的收尾（见上头第 ③ 条）
          sh.fragmentShader = (k >= 0)
            ? sh.fragmentShader.slice(0, k) + INJ + '\n' + sh.fragmentShader.slice(k)
            : sh.fragmentShader;
        };
      } else {
        mat.side = s.side;
        mat.onBeforeCompile = s.obc;                     // 还原（一般是 undefined）
      }
      mat.needsUpdate = true;      // 换了 shader 必须让它重编，不然还是旧的那份
    });
  });
}

/* ---------- 「平面着色」（阿聪 2026-10-15）----------
   干什么：`material.flatShading = true` —— **无视顶点法线、一个面一个平色**。

   为什么要它（他这一整轮的判据都是"**我要亲眼看到事实才能做改动**"）：
   白模上那些明暗是**光照 + 法线**算出来的，而**这份低模自带法线数据**
   （Tripo 当显式数据塞进文件里的 —— 原后处理第 ① 步就是专门清它，**那步今天被删了**）
   → 明暗里**可能混着假象**（自带法线要是脏的，会让人看错几何）。
   **平面着色正好把这层剥掉**：不看顶点法线、按面算 → 屏幕上就剩**几何的真身**。

   ⚠️ **默认关、点得开**（2026-10-15 改的：原来那个"默认开"让给了**自动平滑** ——
      阿聪 要"以后默认开自动平滑"）—— 功能留着，要看**面级**问题的时候点一下。
      每次打开弹层都回到**关**（跟「显示原点」一个规矩：非常态的不赖着不走）。
   ⚠️ **只作用于弹层预览**（`pv3dObj`）。**卡片小图不动** —— 那个走的是**另一套渲染台**
      （`stMaterials` 的 `keep/toon/flat/wire` 预设），要改是另一摊事（报告里说明，等阿聪 定）。
   ⚠️ **跟别的模式不打架**：`flatShading` 是个**材质属性**，白模 / 法线 / UV 那几个改的是
      贴图和颜色，各碰各的槽。**UV 检查 / 权重图**换的是 `MeshBasicMaterial`（本来就不吃光照）
      → 平面着色在它们身上**看不出来**，属正常（那两样本来就不看明暗）。
   ⚠️ 改它**必须 `needsUpdate = true`**（要重编 shader），不然画面纹丝不动。 */
/* ⚠️ 2026-10-15 改：**默认从"开"改成了"关"** —— 阿聪 要"以后默认开**自动平滑**"，
   常态那一档让给自动平滑了；平面着色**功能留着**（他要"看面级问题"的时候点一下）。
   「每次打开都回这个值」这条没变。 */
var flatOn = false;

function pv3dApplyFlat(){
  if (!pv3dObj || typeof pv3dObj.traverse !== 'function') return;
  pv3dObj.traverse(function(o){
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(mat){
      if (mat.flatShading !== flatOn){
        mat.flatShading = flatOn;
        mat.needsUpdate = true;
      }
    });
  });
}

/* ---------- 「自动平滑」（阿聪 2026-10-15）----------
   干什么：**按面与面的夹角分** —— 夹角**小于阈值**的面之间**平滑**（渐变、看不出面），
   **大于阈值**的留**硬边**（锐利）。就是 **Blender 那个「自动平滑」**的语义。

   为什么要有它（他看完「平面着色」的效果之后改的主意）：
   · 平面着色 = **全硬边** → 低模上**太糙**（他说"效果这么差"）
   · 原来的全平滑 = **可能把问题抹平**（看不出哪块几何有问题）
   · **自动平滑 = 中间那个**：曲面平滑、硬边保留。

   实现：three 官方的 **`toCreasedNormals(geometry, angle)`** —— 它就是 Blender Auto Smooth 的等价物
   （文件头上 import 了；那个模块**本来就在 vendor 包里**、零新增体积）。
   ⚠️ 它**会改几何**（按角度拆顶点 + 重算顶点法线），不是调个开关 ——
      所以关掉时得把**原始几何原样还回去**（`userData.__smoothSrc` 存一份）。
   ⚠️ 它跟「平面着色」**不用互斥**：一个改**顶点法线**（几何数据），一个设 `flatShading`
      （shader 直接**无视**顶点法线）→ 平面着色开着时自动平滑"看着没效果"是**正常**的，
      平面着色一关、它**立刻回来**（不用重新点它）。
   ⚠️ **性能**：它要按顶点分组，**高模（2.1 那种上百万面）会明显慢**（2026-10-15 已报给指挥官）。
   ⚠️ 阈值 **30°**（跟 Blender 默认一致）—— 太小接近全硬边，太大接近全平滑。 */
var AUTO_SMOOTH_DEG = 30;
var AUTO_SMOOTH_ANGLE = AUTO_SMOOTH_DEG * Math.PI / 180;
var autoSmoothOn = true;      // 默认**开**（阿聪：「以后**默认开自动平滑**」）

function pv3dApplyAutoSmooth(){
  if (!pv3dObj || typeof pv3dObj.traverse !== 'function') return;
  pv3dObj.traverse(function(o){
    if (!o.isMesh || !o.geometry) return;
    /* 第一次进来把**原始几何**存住 —— 关掉时要原样还回去（`toCreasedNormals` 给的是**新的一份**） */
    if (!o.userData.__smoothSrc) o.userData.__smoothSrc = o.geometry;
    if (autoSmoothOn){
      if (o.userData.__creased) return;          // 已经算过，别每点一次重算一遍
      try{
        o.geometry = toCreasedNormals(o.userData.__smoothSrc, AUTO_SMOOTH_ANGLE);
        o.userData.__creased = true;
      }catch(e){
        /* 🔴 算不动就**保持原样** —— 宁可看不见自动平滑，也不能因为它把整个预览搞挂
           （跟 `m3dFacing` 那条"锦上添花、失败不阻断"一个道理）。 */
        o.geometry = o.userData.__smoothSrc;
      }
    } else if (o.userData.__creased){
      o.geometry = o.userData.__smoothSrc;
      o.userData.__creased = false;
    }
  });
}

/* ---------- 显示骨架（阿聪 2026-10-06 提的）----------
   原话：「这个绑骨单元页……这里可以给 glbview 开通一个功能，叫**显示骨架**」。

   4.1 之后的产出都带骨架（glb 里有 `skin`），但预览里**只看到网格** ——
   骨头长在身体里面，**摆得正不正、朝向对不对，全靠猜**。这个开关把它画出来。

   🔴 **判据不看步骤，看模型自己有没有骨头**（`isBone`）。
   跟 UV / 法线不一样：那两张贴图会被下游丢掉，所以得让宿主（`app.js`）传参告诉它；
   而骨架是**长在 glb 里的**，加载完一 `traverse` 就知道。
   这样 4.1 及其后自动能点，**单元页拖个带骨的 glb 进来也一样能用** ——
   这个能力属于 glbview 自己，不劳宿主告诉它。

   ⚠️ **不是** `THREE.SkeletonHelper`（它也能画，但有个暗雷：
      `this.matrix = object.matrixWorld` 是**引用**、`matrixAutoUpdate = false`，
      挂错位置（挂到它自己那个 root 底下）会**双重变换**、线全画飞）。
   自己画还多一样东西：**关节球** —— 能看出每根骨的关节落在哪儿，不只是连线。

   两个画法上的决定：
   ① 线**挂在"父骨"下**、用局部坐标（子骨原点在父骨局部系里就是 `bone.position`）——
      交给 Three 的矩阵树去算，**动画播起来它自己会跟着动**，不用每帧重算。
   ② 材质 **`depthTest:false`** —— 骨头本来就长在身体里，不穿透就等于什么都看不见
      （X 光效果）；配合 `renderOrder` 拉高压在网格上面。 */
/* 骨架那张卡的状态（= 法线那张一个形态）：
   `''` = 不画 ｜ `'bone'` = 画骨头 ｜ `'name'` = 画骨头 + 标名字。
   ⚠️ 两个布尔（`skelOn` / `boneNameOn`）合成了一个 —— 它俩本来就是一回事的两档。 */
var skelView = '';
function skelOn(){ return skelView !== ''; }
function boneNameOn(){ return skelView === 'name'; }
/* 骨名（2026-10-06 加）—— 每根骨一个小 DOM 标签，每帧把它的世界坐标
   **投影到屏幕上**摆过去（不用 Sprite：文字清楚、不占显存、样式随便调）。
   `[{ bone: 骨头, el: 标签DOM }]`，跟着骨架一起建/一起清。 */
var pv3dBoneLabels = [];

function pv3dFindBones(obj){
  var out = [];
  if (obj) obj.traverse(function(o){ if (o.isBone) out.push(o); });
  return out;
}

/* 把每个标签摆到它那根骨的屏幕位置上。**每帧调**（模型转了、相机动了都要跟）。 */
function pv3dPlaceBoneLabels(){
  if (!pv3dBoneLabels.length) return;
  var stage = document.getElementById('pv3dStage');
  if (!stage || !camera) return;
  var w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  var v = new THREE.Vector3();
  pv3dBoneLabels.forEach(function(it){
    it.bone.getWorldPosition(v).project(camera);
    /* z 出 [−1,1] 说明跑到相机后面去了 —— 藏起来，不然会「镜像」到画面上 */
    if (v.z > 1){ it.el.style.display = 'none'; return; }
    it.el.style.display = '';
    it.el.style.transform = 'translate(' + ((v.x * 0.5 + 0.5) * w) + 'px,'
                          + ((-v.y * 0.5 + 0.5) * h) + 'px) translate(-50%,-50%)';
  });
}

/* 清掉所有骨名标签（换模型 / 关开关 / 重画骨架时都要） */
function pv3dClearBoneLabels(){
  pv3dBoneLabels.forEach(function(it){ if (it.el.parentNode) it.el.parentNode.removeChild(it.el); });
  pv3dBoneLabels = [];
}

/* ═══════════ 🦴 拖动骨骼：核心那几个函数 ═══════════
   （为什么有这东西、形态是怎么定的，见上面 `poseMode` 那段）
   ═══════════════════════════════════════════════════ */

/* 记下**打开那一刻**的原始姿势 —— 关掉时要一根一根还原回去。
   ⚠️ 记 `position` / `quaternion` / `scale` 三样（不是矩阵）：还原时直接 copy，
      比反算矩阵稳，也不会因为欧拉角顺序踩坑。 */
function pv3dPoseSaveBind(){
  poseBind = [];
  if (!pv3dObj) return;
  pv3dFindBones(pv3dObj).forEach(function(b){
    poseBind.push({ b: b,
                    p: b.position.clone(),
                    q: b.quaternion.clone(),
                    s: b.scale.clone() });
  });
}

/* 还原原姿势（关掉开关、关弹层，两处都调）。
   为什么要还原：拖出来的姿势**不是产出的一部分** —— 它是"临时看看形变"的手段。
   不还原的话，关掉再开还是那个被拖歪的样子，人会以为模型坏了。 */
function pv3dPoseRestore(){
  if (poseBind){
    poseBind.forEach(function(r){
      r.b.position.copy(r.p);
      r.b.quaternion.copy(r.q);
      r.b.scale.copy(r.s);
    });
    poseBind = null;
  }
  pv3dPoseDetach();
}

/* gizmo —— three 自带的 `TransformControls`，就是 Blender 那种三轴拖柄。
   🔴 **必须挂在 bone 上，不能挂给蒙皮网格**：glTF 里蒙皮网格的位置是**由骨骼矩阵
      算出来的**，给它挂 gizmo 拖的是它自己的 transform，网格压根不动
      （three.js 论坛里那个经典坑：skinned mesh 不能直接"选中拖动"）。
   懒建 —— 没打开过「拖骨骼」的人不该为它付一份场景对象的钱。 */
function pv3dPoseTC(){
  if (poseTC) return poseTC;
  poseTC = new TransformControls(camera, renderer.domElement);
  /* ⚠️ 2026-10-06 阿聪：「**点旋转后的那个大圆球，挡住了**」——
     默认/1.1 那档，三个圆环能盖住小半个模型，**把别的关节球压在底下点不着**。
     0.55 大约是原来一半，够拖、也不挡路。 */
  poseTC.setSize(0.55);
  poseTC.setSpace('local');     // **局部**坐标 —— 摆姿势要的就是"绕这根骨自己转"
  /* 拖 gizmo 的时候**别让相机跟着转**：两个都吃 pointermove，不掐掉会打架 */
  poseTC.addEventListener('dragging-changed', function(e){
    if (controls) controls.enabled = !e.value;
  });
  /* gizmo 要**穿透显示** —— 骨头长在身体里，gizmo 被网格挡住的话既看不见也点不着
     （骨架的关节球也是这么处理的）。 */
  var helper = (typeof poseTC.getHelper === 'function') ? poseTC.getHelper() : poseTC;
  if (helper && helper.traverse){
    helper.traverse(function(o){
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
        m.depthTest = false;
      });
      o.renderOrder = 999;
    });
  }
  scene.add(helper);
  return poseTC;
}

/* ═══════════ 🎨 权重图 ═══════════
   挑一根骨 → 整个模型按"每个顶点被这根骨影响多少"着色。
   🔑 阿聪 2026-10-06 要的：「**能看到每根骨头的权重吗，就是能做个权重图的显示吗**」
      —— 起因是他拖完骨头觉得"权重生成的一般"，但光靠拖看不出**哪儿**一般。
      权重图就是把这件事摊开：哪块该红没红（没绑上）、哪块串色了（绑错了），一眼可见。
   ═══════════════════════════════ */

/* 权重 → 颜色：蓝 0 → 青 .25 → 绿 .5 → 黄 .75 → 红 1。
   跟 Blender / Maya 的权重绘色**同一套配色**，美术一眼认得"红=吃满、蓝=没吃到"。 */
function pv3dWeightColor(w){
  var r, g, b;
  if (w < 0.25){ r = 0; g = w * 4; b = 1; }
  else if (w < 0.5){ r = 0; g = 1; b = 1 - (w - 0.25) * 4; }
  else if (w < 0.75){ r = (w - 0.5) * 4; g = 1; b = 0; }
  else { r = 1; g = 1 - (w - 0.75) * 4; b = 0; }
  return [r, g, b];
}

/* 把权重图画上。用的是**当前选中的那根骨**（`poseBone`，跟姿态模式共用一个选中）。
   返回画了几个网格（0 = 没蒙皮 / 没挑骨头）。 */
function pv3dApplyWeightMap(){
  if (!pv3dObj) return 0;
  pv3dClearWeightMap();                     // 先清上一次的（换骨头要重画）
  if (!weightOn) return 0;
  var targetIdx = -1;
  var n = 0;
  pv3dObj.traverse(function(o){
    if (!o.isSkinnedMesh || !o.skeleton || !o.geometry) return;
    var si = o.geometry.attributes.skinIndex;
    var sw = o.geometry.attributes.skinWeight;
    if (!si || !sw) return;
    if (targetIdx === -1 && poseBone) targetIdx = o.skeleton.bones.indexOf(poseBone);
    /* 一个顶点可能被 4 根骨影响 → 把"指向这根骨"的那几槽**加起来** */
    var cnt = o.geometry.attributes.position.count;
    var col = new Float32Array(cnt * 3);
    for (var v = 0; v < cnt; v++){
      var w = 0;
      if (targetIdx >= 0){
        for (var k = 0; k < 4; k++){
          if (si.getComponent(v, k) === targetIdx) w += sw.getComponent(v, k);
        }
      }
      var c = pv3dWeightColor(w);
      col[v * 3] = c[0]; col[v * 3 + 1] = c[1]; col[v * 3 + 2] = c[2];
    }
    o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    /* 换材质：`MeshBasicMaterial` + 顶点色 = 纯看颜色，不带光照干扰。
       ⚠️ **蒙皮照样生效** —— 变形是在顶点着色器里做的，跟用哪个材质无关。 */
    if (!o.__wOrigMat) o.__wOrigMat = o.material;
    o.material = new THREE.MeshBasicMaterial({ vertexColors: true });
    n++;
  });
  return n;
}

/* 把权重图擦掉、材质还回去（关开关 / 换模型 / 关弹层都要走这儿）。
   ⚠️ 顶点色那个属性也要删 —— 留着的话，等会儿开「UV 检查」之类的
      可能被 `vertexColors` 的半残状态干扰。 */
function pv3dClearWeightMap(){
  if (!pv3dObj) return;
  pv3dObj.traverse(function(o){
    if (o.__wOrigMat){ o.material = o.__wOrigMat; delete o.__wOrigMat; }
    if (o.geometry && o.geometry.attributes.color) o.geometry.deleteAttribute('color');
  });
}

/* 选一根骨 —— 画布上点关节球、从骨名列表里点，都走这儿。
   🔑 **两根线共用一个"选中的骨"**：
      · 「姿态模式」→ 还要把拖拽把手（gizmo）挂上去
      · 「权重图」  → 只按这根骨的权重重新着色，**不挂 gizmo**
        （只看颜色的时候，一个三轴把手横在模型上是纯碍事）
   所以 gizmo 只在 `poseOn` 时才挂。 */
function pv3dPoseAttach(bone){
  if (!bone) return;
  poseBone = bone;
  if (poseOn){
    var tc = pv3dPoseTC();
    tc.setMode(poseTool === 'move' ? 'translate' : 'rotate');
    tc.attach(bone);
    tc.visible = true;
  }
  if (weightOn) pv3dApplyWeightMap();          // 权重图开着 → 按新选的骨重画
  pv3dSyncPoseUI();                            // 列表高亮跟上
}

function pv3dPoseDetach(){
  poseBone = null;
  if (poseTC){ try{ poseTC.detach(); }catch(e){} poseTC.visible = false; }
}

/* 点一根骨 —— raycast 打**关节球**（`pv3dApplySkeleton` 建的那些，标了 `__skel`）。
   ⚠️ 别去打 bone 本身：glTF 里的 bone 是**空的 Object3D、没有几何体**，
      raycaster 根本打不中它。关节球是挂在骨**下面**的 Mesh，
      打中了取 `parent` 就是那根骨。 */
function pv3dPosePick(ev){
  if (!poseOn || !pv3dObj) return false;
  var rect = renderer.domElement.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  var pt = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  var rc = new THREE.Raycaster();
  rc.setFromCamera(pt, camera);
  var dots = [];
  pv3dObj.traverse(function(o){
    if (o.isMesh && o.userData && o.userData.__skel) dots.push(o);
  });
  if (!dots.length) return false;
  var hit = rc.intersectObjects(dots, false)[0];
  if (!hit) return false;
  var bone = hit.object.parent;
  if (bone && bone.isBone){ pv3dPoseAttach(bone); return true; }
  return false;
}

/* 把界面刷成"当前状态该有的样子" —— 按钮亮暗 / 浮层显隐 / 那行提示。
   🔑 **只有这一处**改界面（状态一变就调它），免得又出"状态改了、界面没跟上"
     那种老毛病（这项目栽过好几次）。 */
/* 🎬 动画控件跟姿态控件**都在左上角** —— 两个同时开时，把动画那块**往下让**。
   ⚠️ 为什么不写死 CSS：姿态那块的高度**不固定**（骨名列表能折叠、还能滚动），
      静态算不出来，必须量真实的 `getBoundingClientRect()`。 */
function pv3dLayoutAnimCtl(){
  var ac = document.getElementById('pv3dAnimctl');
  var pc = document.getElementById('pv3dPosectl');
  var st = document.getElementById('pv3dStage');
  if (!ac || ac.hidden || !pc || !st) return;    // 动画控件没露就不用管
  var top = 14;
  if (!pc.hidden){
    var sr = st.getBoundingClientRect(), pr = pc.getBoundingClientRect();
    if (pr.height > 0) top = Math.round(pr.bottom - sr.top) + 8;
  }
  ac.style.top = top + 'px';
}

function pv3dSyncPoseUI(){
  var b = document.getElementById('pv3dPose');
  if (b) b.classList.toggle('did', poseOn);
  /* 浮层（操作 + 权重图 + 骨名列表）：**跟着姿态模式**露。
     ⚠️ 「权重图」现在是**浮层里的一件**（阿聪：「在操作和骨骼中间插一个」）——
        所以浮层的显隐只看 `poseOn`，不能让它自己被 `weightOn` 牵着（那会成环）。 */
  var ct = document.getElementById('pv3dPosectl');
  if (ct) ct.hidden = !poseOn;
  /* 🎞 动画浮层**跟姿态浮层一个规矩**：跟着自己的总开关露（`animModeOn`）。
     ⚠️ 不是"有动作就露" —— 阿聪 2026-10-06：「左上角那些是**动画模式才出现**，
        就跟姿态模式才出现操作按键一样」。 */
  var act = document.getElementById('pv3dAnimctl');
  if (act) act.hidden = !animModeOn;
  var amb = document.getElementById('pv3dAnimMode');
  if (amb) amb.classList.toggle('did', animModeOn);
  pv3dLayoutAnimCtl();       // 姿态浮层露没露变了 → 动画控件跟着挪位置
  var wb = document.getElementById('pv3dWeight');
  if (wb) wb.classList.toggle('on', weightOn);
  /* 标亮哪些按钮 —— ⚠️「复位姿势」是**动作**不是工具，**永远不亮**
     （把它也算进去的话，它会一直亮着，看着像"当前工具=复位"）。 */
  Array.prototype.forEach.call(
    document.querySelectorAll('#pv3dPosectl .pv3d-posebtn'), function(x){
      var t = x.getAttribute('data-tool');
      x.classList.toggle('on', t !== 'reset' && t === poseTool);
    });
  /* 骨名列表里**当前选中的那根**高亮（点画布上的关节球也会走到这儿）。
     ⚠️ 选的是 `.pv3d-bonepick` —— 列表顶上还有个「全部折叠」按钮，
        照旧写 `#pv3dBoneList button` 会把它也卷进来。 */
  Array.prototype.forEach.call(
    document.querySelectorAll('#pv3dBoneList .pv3d-bonepick'), function(x){
      x.classList.toggle('on', !!poseBone && x.textContent === (poseBone.name || '(无名骨)'));
    });
  var tip = document.getElementById('pv3dTip');
  if (tip) tip.textContent = poseOn
    ? '点一根骨（画布上点，或左上角列表里选）→ 拖它｜W 移动 / E 旋转 / R 复位'
      + ' ｜ 再点「姿态模式」= 退出'
    : '拖动旋转 · 滚轮缩放 · 双击画面也能复位';
}

/* 进 / 出姿态模式（总开关）。不传 `on` = 切换。 */
function pv3dSetPose(on){
  on = (on === undefined) ? !poseOn : !!on;
  if (on === poseOn) return;
  if (on){
    pv3dPoseSaveBind();                     // 记下**原始姿势**，退出时要还原
    poseOn = true;
    /* 进姿态模式**必须有骨架** —— 关节球不画出来的话，人根本点不中骨头
       （`pv3dPosePick` 打的就是那些球）。所以顺手把「显示骨架」点亮。 */
    if (!skelView){ skelView = 'bone'; pv3dMarkSkelBtns(); pv3dApplySkeleton(); }
    pv3dFillBoneList();                     // 顺带把骨名列表填上
  } else {
    poseOn = false;
    pv3dPoseRestore();                      // 退出 = 还原（画布上不留一个被拖歪的模型）
    /* 🔴 **权重图跟着一起关** —— 它的按钮在那排浮层里（阿聪：「在操作和骨骼中间」），
       浮层一收，"怎么关它"就没地方点了。所以退出姿态模式时顺手擦掉。 */
    if (weightOn){ weightOn = false; pv3dClearWeightMap(); }
  }
  pv3dSyncPoseUI();
}

/* 把骨名列表填上（进姿态模式时调一次）。
   ⚠️ 每次进都**重填** —— 换了模型骨头就不一样了。
   ⚠️ 显示的是 Three.js 给的 `bone.name` —— **glTF loader 会把点名里的 `.` 洗掉**
      （源文件 `Shoulder.L` 到这儿是 `ShoulderL`）。画布上那个骨名标签用的也是它，
      所以**两处一致**，美术照着认就行。 */
function pv3dFillBoneList(){
  var box = document.getElementById('pv3dBoneList');
  if (!box) return;
  box.innerHTML = '';
  if (!pv3dObj) return;

  var bones = pv3dFindBones(pv3dObj);
  /* 从**根骨**往下递归渲染（阿聪 2026-10-06：「这个骨架能**搞层级**吗」）——
     父子缩进 + 每条有子骨的能**折叠**。
     ⚠️ 有些 glb 的骨架是「平的」（所有骨挂在同一个父节点下、彼此没有父子骨关系），
        那时"根骨"就是全部，缩进恒为 0 —— **自然退化成平铺列表**，不会出错。 */
  var roots = bones.filter(function(b){ return !(b.parent && b.parent.isBone); });
  if (!roots.length) roots = bones;         // 兜底：一个根都找不到就平铺

  /* 顶上那排：**全展 / 全折 / 收起**，三个按钮各管各的。
     ⚠️ 阿聪 2026-10-06：「**分成全展和全折，收起三个按钮**」——
        原来"全折/全展"是**同一个按钮变文字**（点一下换一次名），
        得先看清它当前写的是哪个、才知道点下去会怎样。拆成两个一眼就明白。 */
  var head = document.createElement('div');
  head.className = 'pv3d-bonelist-head';
  head.title = '共 ' + bones.length + ' 根骨';   // 骨数挪到 tooltip（面板窄，标题栏放不下）

  /* 全部展开 */
  var ex = document.createElement('button');
  ex.type = 'button';
  ex.textContent = '全展';
  ex.title = '把每一支都展开';
  ex.addEventListener('click', function(ev){
    ev.stopPropagation();
    pv3dBoneFoldAll(box, false);
  });

  /* 全部折叠 */
  var fo = document.createElement('button');
  fo.type = 'button';
  fo.textContent = '全折';
  fo.title = '把每一支都折起来，只留最上面那根';
  fo.addEventListener('click', function(ev){
    ev.stopPropagation();
    pv3dBoneFoldAll(box, true);
  });

  /* 「收起」—— 把**整条列表**藏掉（只留上面那排操作按钮）。
     为什么单独要有这个：面板一大就挡住画布，模型那半边的骨点不着
     （阿聪：「**我点有点不到其他骨骼了**」）。 */
  var hide = document.createElement('button');
  hide.type = 'button';
  hide.textContent = '收起';
  hide.title = '把骨名列表收起来，别挡着模型';
  hide.addEventListener('click', function(ev){
    ev.stopPropagation();
    var hid = box.classList.toggle('hid');
    hide.textContent = hid ? '骨骼' : '收起';
  });

  head.appendChild(ex);
  head.appendChild(fo);
  head.appendChild(hide);
  box.appendChild(head);

  var frag = document.createDocumentFragment();
  roots.forEach(function(r){ frag.appendChild(pv3dBoneNode(r, 0)); });
  box.appendChild(frag);
}

/* 全部展开 / 全部折叠 —— 「全展」「全折」两个按钮共用这一处，别各写一遍
   （各写一遍迟早只改一个）。`fold = true` 就是全折。 */
function pv3dBoneFoldAll(box, fold){
  Array.prototype.forEach.call(box.querySelectorAll('.pv3d-bonesub'), function(s){
    s.classList.toggle('hid', fold);
  });
  Array.prototype.forEach.call(box.querySelectorAll('.pv3d-bonetog'), function(x){
    if (!x.classList.contains('leaf')) x.textContent = fold ? '▸' : '▾';
  });
}

/* 一根骨 = 一行（箭头 + 名字）+ 它的子树。递归。
   `depth` 只用来算缩进 —— 一格 12px，四层就够看出从属关系了。 */
function pv3dBoneNode(bone, depth){
  var kids = (bone.children || []).filter(function(c){ return c.isBone; });
  var node = document.createElement('div');
  node.className = 'pv3d-bonenode';

  var row = document.createElement('div');
  row.className = 'pv3d-bonerow';
  row.style.paddingLeft = (depth * 12) + 'px';

  /* 折叠箭头 —— 没子骨的留个**空位**（`leaf`），不然同级名字对不齐 */
  var tog = document.createElement('button');
  tog.type = 'button';
  tog.className = 'pv3d-bonetog' + (kids.length ? '' : ' leaf');
  tog.textContent = kids.length ? '▾' : '▾';   // ▾
  row.appendChild(tog);

  var pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'pv3d-bonepick';
  pick.textContent = bone.name || '(无名骨)';
  /* ⚠️ 面板窄，长骨名会截成 `mixamori…` —— 鼠标停一下给**全名** */
  pick.title = bone.name || '';
  pick.setAttribute('data-bone', bone.name || '');
  pick.addEventListener('click', function(ev){
    ev.stopPropagation();                   // 别让画布的 pointerdown 再当一次"点选"
    pv3dPoseAttach(bone);
    pv3dSyncPoseUI();                       // 高亮跟上
  });
  row.appendChild(pick);
  node.appendChild(row);

  if (kids.length){
    /* 🔴 **默认只展开第一层**（阿聪 2026-10-06：「**ui 能改小点吗，
       我点有点不到其他骨骼了**」）—— 34 根骨全铺开的话，面板能盖住小半个画布，
       模型那半边的骨就点不着了。第一层留着（一眼看到主干），往下都折起来。 */
    var collapsed = depth >= 1;
    var sub = document.createElement('div');
    sub.className = 'pv3d-bonesub' + (collapsed ? ' hid' : '');
    kids.forEach(function(k){ sub.appendChild(pv3dBoneNode(k, depth + 1)); });
    node.appendChild(sub);
    if (collapsed) tog.textContent = '▸';   // ▸
    tog.addEventListener('click', function(ev){
      ev.stopPropagation();
      var hid = sub.classList.toggle('hid');
      tog.textContent = hid ? '▸' : '▾';   // ▸ / ▾
    });
  }
  return node;
}

/* 切工具：`'rotate'` 转（E）｜ `'move'` 移（W）。
   ⚠️ 换工具**不动姿势** —— 只是 gizmo 换个形态，人还在摆着呢。 */
function pv3dSetPoseTool(t){
  if (t !== 'rotate' && t !== 'move') return;
  poseTool = t;
  if (poseBone) pv3dPoseAttach(poseBone);   // 已经选中骨头的话，gizmo 立刻换形态
  pv3dSyncPoseUI();
}

/* 🔄 把姿势**复位回刚进来那样**，但**不退出姿态模式**（阿聪 2026-10-06）。
   跟 `pv3dPoseRestore` 的区别就在这儿：那个是"退出"那条路，会**连 `poseBind` 一起清掉**
   （清了就再也回不去了）；这个得**留着**，复位完还能接着拖、接着复位。 */
function pv3dPoseResetPose(){
  if (!poseBind) return;
  poseBind.forEach(function(r){
    r.b.position.copy(r.p);
    r.b.quaternion.copy(r.q);
    r.b.scale.copy(r.s);
  });
}

function pv3dApplySkeleton(){
  if (!pv3dObj) return;
  // 跟「显示布线」一个套路：标 `__skel`，traverse 找出来拆掉（每切一次重画，避免叠层）
  var old = [];
  pv3dObj.traverse(function(o){ if (o.userData && o.userData.__skel) old.push(o); });
  old.forEach(function(o){
    if (o.parent) o.parent.remove(o);
    if (o.geometry) o.geometry.dispose();
    if (o.material) o.material.dispose();
  });
  /* ⚠️ 标签要在 `if (!skelOn) return;` **之前**清 ——
     不然关掉骨架时，骨头拆了、标签还挂在画布上。 */
  pv3dClearBoneLabels();
  if (!skelOn()) return;

  var bones = pv3dFindBones(pv3dObj);
  if (!bones.length) return;

  /* 关节球多大 —— 按**模型自己的高度**定，别写死（高模矮模差几十倍）。
     取 `max.y - min.y` 而不是包围盒对角线：人形是竖着的，按身高最好使。 */
  var bb = pv3dModelBox(pv3dObj);
  var h = bb.isEmpty() ? 1 : (bb.max.y - bb.min.y);
  var r = Math.max(h * 0.006, 1e-5);

  var gJoint = new THREE.SphereGeometry(r, 8, 6);
  var mJoint = new THREE.MeshBasicMaterial({ color: 0xe07b39, depthTest: false, transparent: true });
  var mBone  = new THREE.LineBasicMaterial({ color: 0xc2410c, depthTest: false, transparent: true });

  bones.forEach(function(b){
    // ① 关节：一个小球，挂在**这根骨自己**下面 → 自动跟着走
    var dot = new THREE.Mesh(gJoint, mJoint);
    dot.userData.__skel = true;
    dot.renderOrder = 998;
    /* 🔴 **必须抵消掉骨头链上的缩放**（2026-10-13 修的 bug，阿聪 报「点不了骨骼」）——
       半径 `r` 是按**世界空间**的模型高度算的，可球是挂在**骨头本地空间**里的：
       骨头链上要是有缩放，球的世界半径会**再乘一遍**那个缩放。
       实测：Mixamo 导出的 glb，根节点 `Armature` 带 **scale=0.01**（cm→m 的换算）
       → 球的世界半径变成 **0.06 毫米、画布上不到 1 像素** → **永远点不中**。
       ⚠️ 我们自研骨架那条根节点 scale=1，所以这个坑一直没暴露。
       ⚠️ **线为什么没事**：线的粗细是**屏幕像素**（LineBasicMaterial 不吃缩放），
          所以症状是"骨架画出来了、但点不着"。
       👉 修法：按**该骨自己的世界缩放**反向缩放球，让它的世界半径就是 `r`。 */
    b.updateWorldMatrix(true, false);
    var _ws = new THREE.Vector3(), _wq = new THREE.Quaternion(), _wp = new THREE.Vector3();
    b.matrixWorld.decompose(_wp, _wq, _ws);
    var _s = Math.max(Math.abs(_ws.x), Math.abs(_ws.y), Math.abs(_ws.z)) || 1;
    dot.scale.setScalar(1 / _s);
    b.add(dot);
    // ② 骨干：**从父骨原点连到子骨原点**。挂父骨下，终点就是 `b.position`
    //    （position 是"相对父级的平移"，跟它自己的旋转无关）→ 这一步坐标是对的
    if (b.parent && b.parent.isBone){
      var ln = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0), b.position.clone()
        ]),
        mBone);
      ln.userData.__skel = true;
      ln.renderOrder = 997;
      b.parent.add(ln);
    }
  });

  /* 骨名 —— 骨架建好之后才谈得上（所以放最后，且只在 `boneNameOn` 时建）。
     标签挂在**画布的 DOM 上**，位置每帧用投影算（见 `pv3dPlaceBoneLabels`）。 */
  if (boneNameOn()){
    var stage = document.getElementById('pv3dStage');
    if (stage){
      bones.forEach(function(b){
        var el = document.createElement('div');
        el.className = 'pv3d-bone-lb';
        el.textContent = b.name;
        stage.appendChild(el);
        pv3dBoneLabels.push({ bone: b, el: el });
      });
    }
  }
}

/* ---------- UV 检查色块（阿聪 2026-10-04：「能不能出一版带上 uv 色块的 glb 看看」）----------
   🔴 **2026-10-13 晚 改版**（阿聪：「**每个 UV 块一个色块**」）——
   原来是**一张写死的 8×8 棋盘**（谁套上都是那张）。现在改成**照着这个模型自己的 UV 现画**：
   **一个 UV 岛 = 一块纯色**；岛与岛之间的缝 = UV 上真没东西的地方。不依赖任何外部图片。

   👉 **跟 2.3 产出那张 UV 布局图是"一个东西"**（判据同一套，见下）——
      模型上看到几个岛、什么形状，UV 图上就是几个岛、什么形状。
   ⚠️ 色板还是那 8 个粉彩色；但**具体哪个岛配哪个色，两边是各自算的**，
      不保证一一对上（要"颜色也一一对上"得让 UV 图直接当贴图，那是另一条路）。
   ⚠️ 这张贴图**是按模型算的，所以不能再全局共用** —— 缓存挂在**每个 mesh** 上。

   判据（跟 `modules/uvgen/check_uv_islands.py` **同一套**）：
   **两个三角共享一条边（两端 UV 坐标都重合）就是同一个岛**。
   🔴 必须按 UV **坐标**去重、**不能按顶点索引** —— glb 导出时会按 UV 缝把顶点拆开，
      按索引做连通分量会把一个岛数成"一个面一个岛"（`uv_layout_blender.py` 里同一条）。*/
var uvCheckOn = false;
/* 🆕 2026-10-14：「白模」开关 —— 摘掉所有贴图、底色刷白（见 `pv3dSetWhite`）。
   跟 `uvCheckOn` / `bakeView` **抢同一批材质槽** → 三者互斥（见各自的按钮 click）。 */
var whiteOn = false;

var UV_PAL = ['#e5736b','#f0a868','#f2d16b','#9ccb7a','#71c2c7','#7f9fe0','#b78ada','#e88fbe'];
var UV_N = 8;                 // 格子线/坐标还是 8×8（跟 UV 布局图一致）
var UV_TEX_S = 1024;          // 这张检查贴图的分辨率
/* 🔴 配色的两个参数 —— **必须跟 `modules/uvgen/uv_layout_blender.py` 的 `UV_PAD` / `UV_GRID` 一致**。
   两边的"岛 → 颜色"规则整套是一样的（见 `pv3dColorIslands`），**改一边就得改另一边**，
   不然模型上跟 UV 图上同一个岛会是两个色（阿聪 2026-10-13 晚：「这真的对得上吗」就是这个）。*/
var UV_PAD = 0.004;           // 相邻判定：UV 包围盒外扩这么多（≈ 1024 画布上的 4 像素）
var UV_GRID = 1 / 16;         // 分桶用的粗网格

/* 逐三角算「岛号」。返回 { tri:[每个三角的岛号], n:岛数 }；没有 UV 就返回 null。 */
function pv3dIslandOfTriangles(geom){
  var uv = geom.attributes && geom.attributes.uv;
  if (!uv) return null;
  var index = geom.index;
  var nTri = Math.floor((index ? index.count : uv.count) / 3);
  if (!nTri) return null;

  // ① UV **坐标**去重（1e-6 取整）—— 同一个岛里的面，坐标完全一样
  var key2id = new Map(), keyOf = new Array(uv.count);
  for (var i = 0; i < uv.count; i++){
    var k = Math.round(uv.getX(i) * 1e6) + '|' + Math.round(uv.getY(i) * 1e6);
    var id = key2id.get(k);
    if (id === undefined){ id = key2id.size; key2id.set(k, id); }
    keyOf[i] = id;
  }

  // ② 并查集：共享一条边的两个面并起来
  var parent = new Int32Array(nTri);
  for (var t = 0; t < nTri; t++) parent[t] = t;
  function find(a){ while (parent[a] !== a){ parent[a] = parent[parent[a]]; a = parent[a]; } return a; }

  var edge = new Map();
  var vs = [0, 0, 0];
  for (var t2 = 0; t2 < nTri; t2++){
    for (var c = 0; c < 3; c++){
      vs[c] = keyOf[index ? index.getX(t2 * 3 + c) : (t2 * 3 + c)];
    }
    for (var e = 0; e < 3; e++){
      var a = vs[e], b = vs[(e + 1) % 3];
      var ek = a < b ? (a + ':' + b) : (b + ':' + a);
      var lst = edge.get(ek);
      if (lst === undefined) edge.set(ek, [t2]); else lst.push(t2);
    }
  }
  edge.forEach(function(fs){
    var r0 = find(fs[0]);
    for (var j = 1; j < fs.length; j++){ var rk = find(fs[j]); if (rk !== r0) parent[rk] = r0; }
  });

  var root2id = new Map(), tri = new Array(nTri);
  for (var t3 = 0; t3 < nTri; t3++){
    var r = find(t3), ii = root2id.get(r);
    if (ii === undefined){ ii = root2id.size; root2id.set(r, ii); }
    tri[t3] = ii;
  }
  return { tri: tri, n: root2id.size };
}

/* 给每个岛配一个色 —— **相邻的岛尽量不同色**。
   🔴 **整套规则必须跟 `modules/uvgen/uv_layout_blender.py` 的 `island_colors()` 一字不差地一致** ——
      阿聪 2026-10-13 晚：「UV 图上什么色、模型上就什么色」。两边各自算没关系，
      只要**输入相同 + 规则相同**，色号就一模一样。
      👉 所以这里只用**精确可复现**的量：包围盒的 **min/max**（跟遍历顺序无关、浮点不会差）。
         ⚠️ 别改成"求和/求平均"，也别在像素空间取整 —— 那种两边会差一位，色号就分岔。
   规则：① 相邻 = UV 空间包围盒外扩 `UV_PAD` 后相交
        ② 排序 = 面积降序，并列按 (minU, minV, 岛号)
        ③ 贪心 = 在没被已定色邻居占用的色里挑**全局用得最少**的；全被占就挑**邻居用得最少**的 */
function pv3dColorIslands(uv, nTri, tri, nIsl){
  var box = new Array(nIsl), i;
  for (i = 0; i < nIsl; i++) box[i] = [2, 2, -2, -2];
  for (var t = 0; t < nTri; t++){
    var b = box[tri[t]];
    for (var c = 0; c < 3; c++){
      var x = uv.getX(t * 3 + c), y = uv.getY(t * 3 + c);
      if (x < b[0]) b[0] = x;
      if (y < b[1]) b[1] = y;
      if (x > b[2]) b[2] = x;
      if (y > b[3]) b[3] = y;
    }
  }
  /* 🔴 **包围盒要量化到 1e-3**（Blender 那边同样做）——
     Blender 的 UV 是 **float32**，而且导入 glTF 时 V 被翻过（`v = 1 - v_gltf`），
     再翻回来时最后一位会差 ~1e-7。不量化的话，排序/相邻判定会在这些"本应相等"的地方分岔，
     最后**色号对不上**（实测：量化前 31/169 一致，量化后 169/169）。
     👉 量化只是把"肉眼分不出的差别"抹平，对相邻判定的结果没有实际影响。 */
  function q3(x){ return Math.round(x * 1000) / 1000; }
  for (i = 0; i < nIsl; i++){
    box[i][0] = q3(box[i][0]); box[i][1] = q3(box[i][1]);
    box[i][2] = q3(box[i][2]); box[i][3] = q3(box[i][3]);
  }

  // 粗网格分桶 → 只在同桶里比包围盒（UV 空间 16×16 个桶）
  // ⚠️ UV_GRID / UV_PAD 这两个常量 **必须跟 `modules/uvgen/uv_layout_blender.py` 一致**（见文件头那块说明）
  var buckets = new Map();
  for (i = 0; i < nIsl; i++){
    var bx = box[i];
    for (var gx = Math.floor(bx[0] / UV_GRID); gx <= Math.floor(bx[2] / UV_GRID); gx++){
      for (var gy = Math.floor(bx[1] / UV_GRID); gy <= Math.floor(bx[3] / UV_GRID); gy++){
        var bk = gx + ':' + gy, l = buckets.get(bk);
        if (l === undefined) buckets.set(bk, [i]); else l.push(i);
      }
    }
  }
  var adj = new Array(nIsl);
  for (i = 0; i < nIsl; i++) adj[i] = [];
  buckets.forEach(function(l){
    for (var a = 0; a < l.length; a++){
      var ia = l[a], ba = box[ia];
      for (var b2 = a + 1; b2 < l.length; b2++){
        var ib = l[b2], bb = box[ib];
        if (ba[0] - UV_PAD <= bb[2] && bb[0] - UV_PAD <= ba[2] &&
            ba[1] - UV_PAD <= bb[3] && bb[1] - UV_PAD <= ba[3]){ adj[ia].push(ib); adj[ib].push(ia); }
      }
    }
  });

  // 🔴 **排序必须跟 Blender 那边逐条对齐**（面积降序 → 并列按 minU, minV, 岛号）——
  //    不能用 `box[b]-box[a]` 相减：那个跟 Python 的元组比较**舍入方式不同**，边缘上会分岔。
  //    `-area` 只是翻转符号、不引入新舍入；后面几项保证了**全序**（不会有两个岛比不出大小）。
  var negArea = new Array(nIsl), order = [];
  for (i = 0; i < nIsl; i++){
    negArea[i] = -(box[i][2] - box[i][0]) * (box[i][3] - box[i][1]);
    order.push(i);
  }
  /* 🔴 **并列时按整条包围盒比（minU, minV, maxU, maxV）——不能拿"岛号"兜底**：
     岛号是按"面出现的先后"编的，Blender 的面序跟这边的三角序不是同一个，
     拿它兜底 = 顺序分岔 → `usage` 一岔 → **色号全岔**（实测：用岛号兜底只有 26/169 一致）。 */
  order.sort(function(a, b2){
    if (negArea[a] !== negArea[b2]) return negArea[a] < negArea[b2] ? -1 : 1;
    for (var k = 0; k < 4; k++){
      if (box[a][k] !== box[b2][k]) return box[a][k] < box[b2][k] ? -1 : 1;
    }
    return 0;                       // 整条包围盒都一样（极罕见）→ 交给稳定排序
  });

  var cols = new Array(nIsl), usage = new Array(UV_PAL.length);
  for (i = 0; i < UV_PAL.length; i++) usage[i] = 0;
  order.forEach(function(k){
    var used = {};
    adj[k].forEach(function(j){ if (cols[j] !== undefined) used[cols[j]] = 1; });
    var pick = -1, best = Infinity;
    for (var c = 0; c < UV_PAL.length; c++){
      if (used[c]) continue;
      if (usage[c] < best){ best = usage[c]; pick = c; }
    }
    if (pick < 0){                       // 8 个都被邻居占了 → 挑邻居用得最少的
      var cnt = {};
      adj[k].forEach(function(j){ if (cols[j] !== undefined) cnt[cols[j]] = (cnt[cols[j]] || 0) + 1; });
      best = Infinity;
      for (var c2 = 0; c2 < UV_PAL.length; c2++){
        var n = cnt[c2] || 0;
        if (n < best || (n === best && usage[c2] < usage[pick])){ best = n; pick = c2; }
      }
    }
    cols[k] = pick;
    usage[pick]++;
  });
  return cols;
}

/* 画这张检查贴图：**UV 空间**里逐三角填岛色 → 再叠格子线 + 每格坐标。
   ⚠️ 每画一个三角顺手 `stroke()` 一下（同色、线宽 1）—— canvas 路径填充**边缘有抗锯齿**，
      不描边的话相邻三角之间会漏出一条浅色发丝缝，模型上看着像"UV 破成一片片"。*/
function pv3dMakeUVChecker(mesh){
  if (mesh.userData.__uvTex) return mesh.userData.__uvTex;
  var geom = mesh.geometry, uv = geom.attributes && geom.attributes.uv;
  var S = UV_TEX_S;
  var c = document.createElement('canvas');
  c.width = c.height = S;
  var g = c.getContext('2d');
  g.fillStyle = '#000000';                 // 黑底 = UV 上真没东西的地方
  g.fillRect(0, 0, S, S);

  var info = pv3dIslandOfTriangles(geom);
  if (info){
    var cols = pv3dColorIslands(uv, info.tri.length, info.tri, info.n);
    var index = geom.index;
    g.lineWidth = 1;
    for (var t = 0; t < info.tri.length; t++){
      var col = UV_PAL[cols[info.tri[t]]];
      g.fillStyle = col; g.strokeStyle = col;
      g.beginPath();
      for (var v = 0; v < 3; v++){
        /* 🔴 **必须走索引缓冲**（`index.getX`）——
           这个模型的 glb 是**带索引**的：**11826 个顶点 / 55800 个索引 = 18600 个面**。
           第一版这里直接写 `uv.getX(t * 3 + v)`，那是**非索引几何**的取法：
           面号 ×3 一路涨到 55800、**早就超出 11826 个顶点** → 取到 undefined → NaN
           → 色块画到**别的岛/别的地方**去了（阿聪 2026-10-13 晚 报的「色块位置错了」就是它）。
           ⚠️ 只有真的没有索引缓冲时才可以退回 `t * 3 + v`。 */
        var ia = index ? index.getX(t * 3 + v) : (t * 3 + v);
        // UV → canvas 像素：**v=0 落在画布顶部**（跟 glTF 贴图一个朝向，见下面 `flipY = false`）
        var x = uv.getX(ia) * S, y = uv.getY(ia) * S;
        if (v === 0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.closePath(); g.fill(); g.stroke();
    }
    mesh.userData.__uvIslands = info.n;
  }

  // 格子线 + 每格坐标（跟 UV 布局图一个观感：UV 出问题能直接说"是哪一块"）
  var cell = S / UV_N;
  g.strokeStyle = 'rgba(0,0,0,.30)'; g.lineWidth = 2;
  for (var i = 0; i <= UV_N; i++){
    g.beginPath(); g.moveTo(i * cell, 0); g.lineTo(i * cell, S); g.stroke();
    g.beginPath(); g.moveTo(0, i * cell); g.lineTo(S, i * cell); g.stroke();
  }
  g.fillStyle = 'rgba(0,0,0,.55)';
  g.font = 'bold ' + Math.round(S * 17 / 512) + 'px system-ui, "Microsoft YaHei", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (var yy = 0; yy < UV_N; yy++){
    for (var xx = 0; xx < UV_N; xx++){
      g.fillText(xx + ',' + yy, xx * cell + cell / 2, yy * cell + cell / 2);
    }
  }

  var tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  /* 🔴 **`flipY = false` 不能少**（2026-10-13 深夜 实测定的）——
     `CanvasTexture` 默认 `flipY = true`（上传时上下翻一次），那样采样就变成 **v=0 落在画布底部**；
     而上面是按 **v=0 落在画布顶部** 画的（跟 glTF 贴图的朝向一致 —— GLTFLoader 给 glb 里的贴图
     设的也是 `flipY = false`）。两边对不上的话，模型上的色块就是**上下镜像**的。
     ⚠️ 这条是量出来的：把栅格化结果上下翻一下、跟 Blender 那张平铺图比，
        IoU 从 **0.556 → 0.967** —— 就是差这一个方向。
     📌 **改这个必须连"画的时候 y 用不用 1 减"一起改**，两个是一对（见上面那段）。 */
  tex.flipY = false;
  mesh.userData.__uvTex = tex;
  /* 画布左上角那块**平铺 UV 图**用的就是**这张画布本身**（导出成 png 塞进 img）——
     同一张图、不是另画一份，所以它跟模型上看到的**天然一一对应**。 */
  mesh.userData.__uvPng = c.toDataURL('image/png');
  return tex;
}

/* 给**任意一个对象**套上 / 摘掉 UV 色块 ——
   弹层里的大预览和卡片上的缩略图共用这一套（阿聪 2026-10-04：
   「这个预览能不能显示 uv 啊」说的是卡片那张缩略图）。 */
/* 画布左上角那块**平铺 UV 图**（阿聪 2026-10-13：「我要平铺 uv 图，只是这次是显示在这里，
   窗口的左上角」「而且是 uv 检查模式才显示，可大图点击」）。
   🔑 内容是 pv3dMakeUVChecker 画的**那张画布本身** —— 同一张图，跟模型上看到的一一对应。
   ⚠️ **只在弹层那个主模型上显示**：缩略图那条路（`opts.uv`）也会调 pv3dSetUVChecker，
      但那是另一个一次性的场景，不能让它在这儿弹面板。 */
function pv3dShowUVMap(mesh){
  var box = document.getElementById('pv3dUvmap');
  if (!box) return;
  var big = document.getElementById('pv3dUvBig');
  if (!mesh){
    box.hidden = true;
    if (big) big.hidden = true;                 // UV 检查一关，大图也收掉
    return;
  }
  var png = mesh.userData.__uvPng || '';
  document.getElementById('pv3dUvmapImg').src = png;
  var bimg = document.getElementById('pv3dUvBigImg');
  if (bimg) bimg.src = png;
  box.hidden = false;
}

function pv3dSetUVChecker(obj, on){
  if (!obj) return;
  var main = null;                              // 顶点最多的那个 mesh —— 左上角就显示它的
  obj.traverse(function(o){
    if (!o.isMesh || !o.material) return;
    /* ⚠️ 贴图**每个 mesh 各画一张**（按它自己的 UV 算岛）——
       改版前是一张全局共用的 8×8 棋盘，现在不能共用了。 */
    var tex = on ? pv3dMakeUVChecker(o) : null;
    if (on){
      var pa = o.geometry && o.geometry.attributes && o.geometry.attributes.position;
      var cnt = pa ? pa.count : 0;
      if (!main || cnt > main.cnt) main = { cnt: cnt, mesh: o };
    }
    var ms = Array.isArray(o.material) ? o.material : [o.material];
    ms.forEach(function(mat){
      if (on){
        // 第一次套：把原来的贴图/颜色/光度存起来，摘掉时原样还回去
        if (mat.userData.__uvSaved === undefined){
          mat.userData.__uvSaved = {
            map: mat.map || null,
            color: mat.color ? mat.color.getHex() : null,
            metalness: ('metalness' in mat) ? mat.metalness : undefined,
            roughness: ('roughness' in mat) ? mat.roughness : undefined
          };
        }
        mat.map = tex;
        if (mat.color) mat.color.set(0xffffff);          // 别让底色把色块染了
        if ('metalness' in mat) mat.metalness = 0;       // 金属度会把颜色压暗
        if ('roughness' in mat) mat.roughness = 1;
      } else if (mat.userData.__uvSaved !== undefined){
        var s = mat.userData.__uvSaved;
        mat.map = s.map;
        if (mat.color && s.color !== null) mat.color.setHex(s.color);
        if ('metalness' in mat && s.metalness !== undefined) mat.metalness = s.metalness;
        if ('roughness' in mat && s.roughness !== undefined) mat.roughness = s.roughness;
        delete mat.userData.__uvSaved;
      }
      mat.needsUpdate = true;      // 换了 map 必须让它重编 shader
    });
  });
  /* 左上角那块平铺图：只有**弹层那个主模型**（`pv3dObj`）+ 开着 UV 检查时才出现。
     🔴 只有"传进来的就是主模型"时**才碰面板** —— 缩略图那条路也调这个函数
        （卡片小图，`opts.uv`），它传的不是 pv3dObj。
        ⚠️ 第一版写成"不是主模型就隐藏"，结果**后台一刷缩略图、面板就被一排排关掉** ——
           表现就是阿聪 报的「**拖着拖着模型，布局图突然就消失了**，
           关掉 UV 检查再点回来又有了」（日志里那几百行「缩略图好了」就是真凶）。 */
  if (obj === pv3dObj) pv3dShowUVMap((on && main) ? main.mesh : null);
}

/* 左上角小图 ↔ 大图 的点击开关（「可大图点击」）。点哪儿都关，Esc 也关。 */
function pv3dBindUVMapClicks(){
  var box = document.getElementById('pv3dUvmap');
  var big = document.getElementById('pv3dUvBig');
  if (box) box.addEventListener('click', function(e){
    e.stopPropagation();
    if (big) big.hidden = false;
  });
  if (big) big.addEventListener('click', function(){ big.hidden = true; });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && big && !big.hidden) big.hidden = true;
  });
}

function pv3dApplyUVCheck(){ pv3dSetUVChecker(pv3dObj, uvCheckOn); }

/* ---------- 法线 / AO 效果开关（阿聪 2026-10-05）----------
   「我测到 3.1 了嘛，我想看看法线效果和 AO 效果」。

   跟 UV 检查**不一样的地方**：这两个贴图**本来就在模型上**（3.1 的交付就是
   「挂了这两张贴图的模型」），Three 加载 glb 时**自动就生效了**。
   所以：
     · 默认状态是**开着**（按钮带 `did`）—— 如实反映"现在就有效果"
     · 点一下是**关掉**，好跟"没有它"的样子对比（A/B 才看得出它贡献了什么）
   ⚠️ 别默认关 —— 那等于骗人（看起来"没效果"，其实效果一直在）。
   ⚠️ `aoMap` 只作用在**环境光**那一项上，所以这页的半球光（HemisphereLight）在，
       看得出来；要是哪天把环境光删了，AO 就会"点了没反应"。 */
/* 🔴 **一次只看一个**（阿聪 2026-10-05：
   「法线整个按钮和 AO 整个按钮也是互斥的？」——
   原来两张卡各亮一半，两行错着亮，**看着乱**）。
   四格 + 一个"都不亮"，共五种状态，**界面上永远最多只有一格亮**：

     ''        = 都不亮 = **模型原样**（法线 + AO 都生效，就是我们平时看到的样子）
     'n-raw' = 纯法线 —— 只看法线贴图本身（关光照）
     'n-off' = 关掉法线 —— **把法线关掉**，看没有它的裸模型（对比用）

   再点已经亮着的那格 = 回到"都不亮"（模型原样 = 法线生效）。

   ⚠️ **AO 那两格 2026-10-06 撤了**（阿聪：「ao 算了，以后有机会再探索」）——
      原来「法线效果」是"只留法线、把 AO 关掉"，AO 一没了这格就跟"都不亮"重复，
      所以右边那格改成「关掉法线」，正好拿来对比"有没有法线"。 */
var bakeView = '';
/* 🆕 2026-10-15：这一步的「法线那组开关」是不是**锁死**的（宿主传 `opts.bakeLocked`；2.2 是）。
   为什么要在模块里记一份（而不是每次现读 opts）：**白模那个 click 要看它** ——
   锁死时**不许把 `bakeView` 收掉**，不然关白模之后"关掉法线"的**高亮和效果一起回不来**
   （阿聪 2026-10-15 实测报的：「点一次白模再点掉，那个关掉法线就自动没了」）。
   ⚠️ 每次 `pv3dOpen` 重新设一遍（别的宿主不传 = false，行为跟以前一模一样）。 */
var bakeLockedNow = false;

/* 弹层关掉时要回报给谁（2026-10-06 加）。
   阿聪：「**做到里面显示是什么，外面也跟着显示**」—— 宿主把"这个产出上次被看成
   什么样"记在产出上，卡片那张小图照着重画。
   `pv3dOpen` 时设、`pv3dClose` 时调一次就清掉（同一个弹层只报一次）。 */
var pv3dOnClose = null;

/* ── 🦴 拖动骨骼（2026-10-06）──────────────────────────────────
   阿聪：「**能不能让模型跟着骨骼动一动**……像 blender 那样，这个单元页蒙完皮，
   还能让我拖动骨骼动一动，**看看蒙皮质量如何**」。

   为什么值得做：蒙皮那三样毛病 —— **candy wrapper**（关节一扭转，那圈顶点像
   糖纸一样往里缩）、**体积丢失**、**权重泄漏** —— **只有把关节转起来才看得见**。
   静态检查（`modules/rig/check_skin_weights.py`）只能查"绑没绑上"，
   查不了"动起来残不残"。

   形态跟「显示骨架」「纯法线」一样是**一张两格卡**：
     · 左「拖骨骼·转」= 鼠标拖的是**旋转** gizmo（Blender 里按 R 那个）
     · 右「拖骨骼·移」= 拖的是**平移** gizmo（按 G 那个 —— 会把关节拉开，
       正好用来看"极端情况下蒙皮会不会崩"）
     · 两格都不亮 = 关掉，**并且把姿势还原回原样** */
/* ⚠️ 形态是**一个总开关 + 画布右上角一排工具**（阿聪 2026-10-06 改的）——
   原来是一张两格卡（拖骨骼·转 / 拖骨骼·移），他说不清楚：
   「**skin 这个单元页不搞这个什么拖骨骼移骨骼按钮了，直接搞一个总按钮叫姿态模式，
   这个时候骨骼才可动，然后红框处就会出现操作按钮，旋转和移动，然后附上快捷键，
   可以直接用 ue 的同款快捷键**」。 */
var poseOn = false;       // 姿态模式开着没（总开关）
var poseTool = 'rotate';  // gizmo 用哪种：'rotate' 转（E）｜ 'move' 移（W）
var poseAllow = false;    // **这一步允不允许进姿态模式** —— 宿主传 `opts.poseMode` 才有
var weightOn = false;     // 「权重图」开着没（看每根骨的影响范围）
var poseTC = null;        // TransformControls 实例（第一次用到才建）
var poseBone = null;      // 现在挂着哪根骨
var poseBind = null;      // 进模式时记下的**原始姿势**（退出 / 关弹层要还原）

/* 只跟"显示哪张贴图"有关的辅助：改 colorSpace 必须**跟着 needsUpdate**，
   不然 GPU 上那份还是旧格式、而 shader 已按新格式解码 → 画面崩。 */
function pv3dSetTexCS(t, cs){
  /* 🔴 判 null 要写 `cs == null`，**别写 `!cs`**：Three 里 `NoColorSpace` 就是
     **空字符串 `''`**，`!''` 是 true —— "还原回 NoColorSpace"那一步会被自己挡掉
     （2026-10-05 就是栽在这，切来切去之后法线被当颜色解码、渲染一块块花）。 */
  if (!t || cs == null) return;
  if (t.colorSpace !== cs){ t.colorSpace = cs; t.needsUpdate = true; }
}

function pv3dSetBakeMaps(obj, view){
  if (!obj) return;
  obj.traverse(function(o){
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(mat){
      /* 第一次进来把**原样**存住（贴图 + 颜色 + 发光 + 金属度/粗糙度），
         之后每次都**先还原再改** —— 免得几种模式互相污染（跟 UV 检查一个道理）。 */
      if (mat.userData.__bkSaved === undefined){
        var s0 = mat.userData.__bkSaved = {
          nm: mat.normalMap || null, ao: mat.aoMap || null,
          map: mat.map || null,
          emissiveMap: mat.emissiveMap || null,
          color: mat.color ? mat.color.getHex() : null,
          emissive: mat.emissive ? mat.emissive.getHex() : null,
          metalness: ('metalness' in mat) ? mat.metalness : undefined,
          roughness: ('roughness' in mat) ? mat.roughness : undefined
        };
        // 这两张贴图原先是 No-Color（数据，不是颜色）—— 当"纯贴图"显示时要临时当 sRGB 用，
        // 不然渲染管线一转，颜色会偏亮（看着发白，跟 PNG 对不上）
        s0.nmCS = s0.nm ? s0.nm.colorSpace : null;
        s0.aoCS = s0.ao ? s0.ao.colorSpace : null;
      }
      var s = mat.userData.__bkSaved;

      /* ① 先还原成"这个模型本来的样子" */
      mat.normalMap = s.nm;
      mat.aoMap = s.ao;
      mat.map = s.map;
      mat.emissiveMap = s.emissiveMap;
      if (mat.color && s.color !== null) mat.color.setHex(s.color);
      if (mat.emissive && s.emissive !== null) mat.emissive.setHex(s.emissive);
      if ('metalness' in mat && s.metalness !== undefined) mat.metalness = s.metalness;
      if ('roughness' in mat && s.roughness !== undefined) mat.roughness = s.roughness;
      pv3dSetTexCS(s.nm, s.nmCS || THREE.NoColorSpace);
      pv3dSetTexCS(s.ao, s.aoCS || THREE.NoColorSpace);

      /* ② 按 view 定"留谁" —— 见上面那张表。'' = 模型原样（法线生效） */
      var wantNM = true, raw = null;
      if (view === 'n-off'){ wantNM = false; }
      else if (view === 'n-raw'){ wantNM = false; raw = s.nm; }
      mat.normalMap = wantNM ? s.nm : null;
      /* AO 那排按钮撤了（阿聪 2026-10-06：「ao 算了，以后有机会再探索」），
         但**贴图照原样还回去** —— 万一哪个 glb 自带 AO，别顺手给弄没了。 */
      mat.aoMap = s.ao;

      /* ③ 「纯贴图」：把光照关掉 —— `map` 置空 + 底色纯黑（漫反射=0），
            再把贴图塞进 **emissive**（自发光不受光照影响）
            → 屏幕上看到的就是**这张贴图本身**。 */
      if (raw){
        pv3dSetTexCS(raw, THREE.SRGBColorSpace);    // 见上面那段：当颜色看
        mat.map = null;
        if (mat.color) mat.color.setHex(0x000000);
        mat.emissiveMap = raw;
        if (mat.emissive) mat.emissive.setHex(0xffffff);
        if ('metalness' in mat) mat.metalness = 0;
        if ('roughness' in mat) mat.roughness = 1;
      }
      mat.needsUpdate = true;      // 换贴图必须让它重编 shader
    });
  });
}

/* ⚠️ 锁死的步（`bakeLockedNow`）**无条件把 `bakeView` 拉回 `'n-off'`** —— 这是**防弹层**：
   阿聪 要的是"**不管用户怎么点别的开关（白模 / 布线 / 骨架……），2.2 永远是关掉法线**"，
   光靠"每个开关自己别去改 bakeView"早晚漏一个（2026-10-15 白模就漏了一次，见上面 `bakeLockedNow` 那段）。
   ⚠️ 只在锁死的步生效 —— 别的步（2.3 / 3.1 / 4.1…）一个字不受影响。 */
function pv3dApplyBakeMaps(){
  if (bakeLockedNow) bakeView = 'n-off';
  pv3dSetBakeMaps(pv3dObj, bakeView);
}

/* ---------- 「白模」开关（阿聪 2026-10-14）----------
   干什么：把模型上**所有贴图**（底色 / 法线 / AO / 自发光）**全部摘掉**、底色刷纯白、
   金属度归 0、粗糙度归 1 —— 屏幕上只剩**几何形状 + 光照**。

   为什么要它（阿聪 的原话）：「眼睛好了…但是现在有个问题，就是它上面有一些**奇怪的阴影**…
   出一个**白模模式**…这样子呢，我就能看见这个阴影到底是**贴图的问题**，还是**模型本身
   法线**的一些问题」。→ 摘掉贴图**还有阴影 = 模型的事**；**没阴影了 = 贴图的事**。

   ⚠️ 跟「UV 检查」「纯法线 / 关掉法线」**抢同一批材质槽**（都在动 `mat.map` / 光照）→
      三者互斥，由各自的按钮 click 排队收（跟"纯贴图 vs UV 检查"一个道理）。
      🔴 **收的顺序有讲究**：`pv3dSetBakeMaps` 会"把当前状态存成快照"——
         白模开着时它存下去的就是"被摘过的样子" → 以后再切模式就还原成一个空壳。
         **所以任何地方都要"先收白模、再动别的"**（见下面几处 click）。

   为什么**自己一套快照**（`__whiteSaved`）、不复用 `pv3dSetBakeMaps` 的 `__bkSaved`：
   那个是"3.1 才有的法线视图"专用，而白模**每一步都要能用** —— 共用一个快照会在
   "先开白模、再进 3.1"这种顺序下互相踩。 */
function pv3dSetWhite(obj, on){
  if (!obj) return;
  obj.traverse(function(o){
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(mat){
      if (on){
        if (mat.userData.__whiteSaved === undefined){     // 第一次开：把"模型本来的样子"存住
          mat.userData.__whiteSaved = {
            map: mat.map || null, nm: mat.normalMap || null, ao: mat.aoMap || null,
            emissiveMap: mat.emissiveMap || null,
            color: mat.color ? mat.color.getHex() : null,
            emissive: mat.emissive ? mat.emissive.getHex() : null,
            metalness: ('metalness' in mat) ? mat.metalness : undefined,
            roughness: ('roughness' in mat) ? mat.roughness : undefined
          };
        }
        mat.map = null; mat.normalMap = null; mat.aoMap = null; mat.emissiveMap = null;
        if (mat.color) mat.color.setHex(0xffffff);        // 纯白
        if (mat.emissive) mat.emissive.setHex(0x000000);
        if ('metalness' in mat) mat.metalness = 0;        // 金属度会把颜色压暗
        if ('roughness' in mat) mat.roughness = 1;
      } else if (mat.userData.__whiteSaved !== undefined){   // 关：原样还回去
        var s = mat.userData.__whiteSaved;
        mat.map = s.map; mat.normalMap = s.nm; mat.aoMap = s.ao; mat.emissiveMap = s.emissiveMap;
        if (mat.color && s.color !== null) mat.color.setHex(s.color);
        if (mat.emissive && s.emissive !== null) mat.emissive.setHex(s.emissive);
        if ('metalness' in mat && s.metalness !== undefined) mat.metalness = s.metalness;
        if ('roughness' in mat && s.roughness !== undefined) mat.roughness = s.roughness;
        delete mat.userData.__whiteSaved;
      }
      mat.needsUpdate = true;      // 换了贴图必须让它重编 shader
    });
  });
}
function pv3dApplyWhite(){ pv3dSetWhite(pv3dObj, whiteOn); }

/* 缩略图版的「纯法线」—— 3.1 那步的**卡片小图**要显示"我烘出来的这张法线图"。
   做法跟 `pv3dSetBakeMaps` 的 `'n-raw'` 一模一样：关光照、把法线贴图塞进 emissive。
   ⚠️ 单独写一份、**不复用 `pv3dSetBakeMaps`**：那个要先"还原成模型本来的样子"
   （读 `mat.userData.__bkSaved`），而缩略图是**另起一套场景**、没存过那个快照。
   缩略图出完就 `thumbClear()` 放掉了，所以也不用考虑摘回去。 */
/* 缩略图版「显示布线」（2026-10-06 加）。
   起因：阿聪「**做到里面显示是什么，外面也跟着显示**」—— 弹层里开了布线，
   外面那张小图也得是同样一张，不能"里面看得见、卡片上没有"。
   画法跟大预览那边（`pv3dApplyWire`）一模一样，区别只有两点：
     · 作用于**传进来的 obj**（缩略图是另一套场景、另一份模型），不是全局 `pv3dObj`
     · **不看全局 `wireOn`** —— 要不要画由调用方说了算（它是一张一次性的图） */
function pv3dThumbShowWire(obj){
  if (!obj) return;
  var mat = new THREE.LineBasicMaterial({ color: 0x3d3833, transparent: true, opacity: 0.28 });
  obj.traverse(function(o){
    if (o.isMesh && o.geometry){
      o.add(new THREE.LineSegments(new THREE.WireframeGeometry(o.geometry), mat));
    }
  });
}

function pv3dThumbShowNormal(obj){
  if (!obj) return;
  obj.traverse(function(o){
    if (!o.isMesh || !o.material) return;
    (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
      if (!m || !m.normalMap) return;
      pv3dSetTexCS(m.normalMap, THREE.SRGBColorSpace);   // 当颜色看（跟「纯法线」一致）
      m.map = null;
      if (m.color) m.color.setHex(0x000000);
      m.emissiveMap = m.normalMap;
      if (m.emissive) m.emissive.setHex(0xffffff);
      if ('metalness' in m) m.metalness = 0;
      if ('roughness' in m) m.roughness = 1;
      m.needsUpdate = true;
    });
  });
}

/* 缩略图那张小图上**也把骨架画出来**。

   🔴 阿聪 2026-10-06：「**我这看着还是没**」—— 他要的不是"点开才看得到骨架"，
   是**卡片上那张小图就带着骨架**（跟 3.1 的小图铺法线一个道理）。
   我上一轮只做了大预览的默认档，理解窄了。

   ⚠️ 缩略图和弹层预览**各自一套场景**（`THUMB` / `PV3D`），所以骨头得**另建一份**
      挂在这个 obj 上。样式跟大预览一致，只是**球大一点** ——
      256px 的小图上球太细根本看不见。
   ⚠️ 不标名字（那么小的图，一堆字糊成一团）。 */
function pv3dThumbShowSkeleton(obj){
  if (!obj) return;
  var bones = pv3dFindBones(obj);
  if (!bones.length) return;
  var bb = pv3dModelBox(obj);
  var h = bb.isEmpty() ? 1 : (bb.max.y - bb.min.y);
  /* ⚠️ 半径得**比大预览（0.006）粗不少** —— 缩略图只有 256px，模型占 ~200px，
     0.006 的球画出来连一个像素都不到，等于没画。
     2026-10-06 实测：`0.010` 时整张图上"纯橙色"只有 **13 个像素**（还得靠抗锯齿
     才勉强连成线），肉眼基本看不出；提到 `0.018` 之后才真像"骨架"。
     （判据在 `modules/glbview/check_glbview_skeleton.js` 的 6.6 节，直接数橙色像素。） */
  var r = Math.max(h * 0.018, 1e-5);
  var gJ = new THREE.SphereGeometry(r, 8, 6);
  // 不加 `transparent` —— 小图上要**实心**、边缘别糊（大预览那边才需要考虑半透明）
  var mJ = new THREE.MeshBasicMaterial({ color: 0xe07b39, depthTest: false });
  var mB = new THREE.LineBasicMaterial({ color: 0xc2410c, depthTest: false });
  bones.forEach(function(b){
    var dot = new THREE.Mesh(gJ, mJ);
    dot.renderOrder = 998;
    b.add(dot);
    if (b.parent && b.parent.isBone){
      var ln = new THREE.Line(new THREE.BufferGeometry().setFromPoints(
        [new THREE.Vector3(0, 0, 0), b.position.clone()]), mB);
      ln.renderOrder = 997;
      b.parent.add(ln);
    }
  });
}

/* 把「哪个亮着」画对 —— 一次最多一个（`bakeView` 已经保证了这点）。
   🆕 2026-10-15：原来是**一张两格卡的两格**，现在拆成了**两个独立按钮**
   （「纯法线」在左栏、「关掉法线」在调试下拉）→ 各自按 `bakeView` 亮 `did`。
   ⚠️ 两边的样式都吃 `did`（`.pv3d-fit.did` 和 `.pv3d-dbg-item.did`），所以这边一套写法通吃。 */
function pv3dMarkBakeBtns(){
  var raw = document.getElementById('pv3dNormalRaw');
  if (raw) raw.classList.toggle('did', bakeView === 'n-raw');
  var off = document.getElementById('pv3dNormalOff');
  if (off) off.classList.toggle('did', bakeView === 'n-off');
}


window.pv3dOpen = function(url, name, srcUrls, realName, opts){
  try{
    /* 🔴 顺序不能反：**先把弹层显示出来再 boot()**。
       反过来的话，renderer 是按 `.pv3d-box` 的 clientWidth/Height 设尺寸的，
       而弹层那会儿还是 hidden → 量出来是 0×0 → 画布永远 0×0，
       表现就是「弹层打开了、模型也加载完了（提示都收了），但里面一片白」。
       （原来只靠一个 window resize 监听去补尺寸，可没人会为了看模型去缩一下窗口。） */
    nameEl.textContent = name || '模型';
    nameEl.title = realName || '';        // 鼠标停一下还能看到真文件名
    msg.hidden = false; msg.textContent = '正在加载…';
    pv3d.hidden = false;
    /* 关掉时回报给谁 + 上次看成了什么样（见上面 `pv3dOnClose` 那段）。
       `_view0` 在外层定义、加载完的回调里也要用（闭包拿得到）。 */
    pv3dOnClose = (opts && opts.onClose) || null;
    var _view0 = (opts && opts.view) || null;
    /* 「UV 检查」按钮**一直在**，**没 UV 的那几步就灰着**（不藏起来）——
       阿聪 2026-10-04：「2.1 也能显示出 UV 检查这个按钮，只是 2.1 的时候
       按钮是点不了的，**这样就能由始至终用这套**」。
       👉 界面每步长得一样，她不会觉得「怎么这儿突然多了个按钮」；
          悬停还能知道为什么点不了。
       ⚠️ 判断写在这儿、不在加载完的回调里 —— 否则会先闪一下再变。 */
    var _uvBtn0 = document.getElementById('pv3dUV');
    if (_uvBtn0){
      var canUV = !!(opts && opts.uvCheck);
      /* 🆕 2026-10-15：灰的原因**不止一种**（真没 UV / 被锁死），**文案得分档** ——
         不然 2.2 那句"还没有 UV"会骗人（**那一步的 Tripo 产出其实带 UV**）。 */
      var lockedUV = !!(opts && opts.uvLocked);
      _uvBtn0.disabled = !canUV;
      _uvBtn0.title = canUV
        ? '给模型换上 UV 检查色块，看 UV 展得匀不匀'
        : lockedUV
          ? '这一步固定不给看 UV 检查 —— 锁死了'
          : '这一步还没有 UV —— 要到「2.3 建模—UV 展开」之后才能看';
    }
    /* 「纯法线 / 关掉法线」—— 只有**烘过的那一步**（3.1）的产出才带法线贴图。
       做法跟 UV 检查一模一样：一直在、别的步灰着（阿聪 2026-10-05：
       「这两个按钮也是 3.1 才能用的」）。
       ⚠️ **AO 那排 2026-10-06 撤了**（阿聪：「ao 算了，以后有机会再探索」）。 */
    /* 🆕 2026-10-15：记下这一步的法线开关**锁没锁死**（宿主传 `opts.bakeLocked`，2.2 是）——
       白模那个 click 要看它（见模块顶上 `bakeLockedNow` 那段）。放在这儿是因为
       **要在加载完之前就定好**（免得加载过程中刚好有谁去动 `bakeView`）。 */
    bakeLockedNow = !!(opts && opts.bakeLocked);
    /* 🆕 2026-10-15：这组**拆成了两个按钮**（左栏「纯法线」+ 调试下拉「关掉法线」，见上面 HTML）——
       所以"灰不灰 / 为什么灰"这俩都要**各设一遍**。
       ⚠️ 「灰」有**两种原因**（没烘过 / 锁死）→ 文案**分三种**，别让它们互相骗。 */
    var canN = !!(opts && opts.bakeMaps);       // 「关掉法线」能用吗（2.2 起）
    /* 🆕 2026-10-15：「**纯法线**」比它**晚**（3.1 起，见 `网站/app.js` 的 `RAW_NORMAL_FROM`）——
       它是**把法线贴图当颜色铺出来看**，而那张贴图 3.1 才烘出来 →
       早于 3.1 的步上**根本没东西可看**（阿聪 原话：「**这个 2.2 锁住纯法线**」）。 */
    var canRaw = !!(opts && opts.rawNormal);
    var lockedN = !!(opts && opts.bakeLocked);
    var _rawB = document.getElementById('pv3dNormalRaw');
    if (_rawB){
      _rawB.disabled = !canRaw || lockedN;
      _rawB.title = !canRaw
        ? '这一步还没有法线贴图 —— 要到「3.1 贴图—烘焙」烘过才有'
        : lockedN
          ? '这一步固定看「关掉法线」—— 锁死了，切不了'
          : '把法线贴图本身铺上去看（再点一下 = 取消，回模型原样）';
    }
    var _offB = document.getElementById('pv3dNormalOff');
    if (_offB){
      _offB.disabled = !canN || lockedN;
      _offB.title = !canN
        ? '这一步还没有法线贴图 —— 要到「3.1 贴图—烘焙」烘过才有'
        : lockedN
          ? '这一步固定看「关掉法线」—— 锁死了，切不了'
          : '关掉法线贴图，看没加它的裸模型（再点一下 = 取消，回模型原样）';
    }
    /* 「显示骨架」按钮**先按死**，等模型加载完看它到底有没有骨头再决定（见下面回调）——
       同一个弹层反复打开时，上一次可能留着"可点"的状态，不重置会假亮。
       ⚠️ 位置跟界面一致：布线 → UV → 法线 → **骨架**。 */
    var _sBtn0 = document.getElementById('pv3dSkel');
    if (_sBtn0) _sBtn0.disabled = true;
    /* 🎬 动画控件（左上角那块浮层）先收起来 —— 要等模型加载完才知道有没有动作。
       ⚠️ 它**不在左栏那排按钮里**（2026-10-06 阿聪让搬的：那是"动画模式"专属，
          跟姿态模式一样浮在画布左上角），所以这儿藏的是**一整块浮层**。 */
    var _actl0 = document.getElementById('pv3dAnimctl');
    if (_actl0) _actl0.hidden = true;
    /* 左上角那块平铺 UV 图也先收起来 —— 要等模型加载完 + 开着 UV 检查才放出来
       （不然上一条管线看过的图会**残留**到下一个模型上）。大图同理。 */
    var _uvm0 = document.getElementById('pv3dUvmap');
    if (_uvm0) _uvm0.hidden = true;
    var _uvb0 = document.getElementById('pv3dUvBig');
    if (_uvb0) _uvb0.hidden = true;

    boot();
    fitPv3d();

    // 左下角摆上「生成它用的四视图」—— 阿聪 2026-10-03 要的：转着看模型的时候
    // 能顺便对一眼原画，看细节对不对得上
    var sb = document.getElementById('pv3dSrc');
    if (sb){
      sb.innerHTML = '';
      /* 🆕 2026-10-10 阿聪：「左边的图片应该能点击预览吧」——
         点一下开大图。**去哪儿开由宿主决定**（`opts.onSrcClick`）：
         glbview 自己不生孩子，单元页没传就只是不可点，不会报错。 */
      var canOpen = !!(opts && typeof opts.onSrcClick === 'function');
      (srcUrls || []).forEach(function(u, i){
        var im = document.createElement('img');
        im.src = u; im.alt = '';
        if (canOpen){
          im.title = '点一下看大图';
          im.style.cursor = 'zoom-in';
          im.onclick = function(e){ e.stopPropagation(); opts.onSrcClick(u, i); };
        }
        sb.appendChild(im);
      });
      sb.hidden = !(srcUrls && srcUrls.length);
    }
    clearHolder();
    new GLTFLoader().load(url, function(g){
      var obj = g.scene || g.scenes[0];
      holder.add(obj);

      /* 🔴 先按**当前真实尺寸**把渲染器摆正，再算相机。
         弹层刚显示出来那一瞬间布局还没落定（宽高可能是 0 或者是旧的），
         那会儿算出来的相机是歪的 —— 表现是「**第一次打开模型是斜的/偏的，
         关掉重新打开一次反而正常**」（阿聪 2026-10-03 就是这么发现的：
         「我退出重点就正常了」）。 */
      fitPv3d();
      frame(obj);
      msg.hidden = true;

      // 左侧那两样：填真实面数、布线开关归位
      pv3dObj = obj;
      var _tri = document.getElementById('pv3dTri');
      if (_tri) _tri.textContent = pv3dCountTri(obj).toLocaleString();
      /* 布线：宿主记过的样子优先，没有才从"没开"开始（原来是**每次打开都归零**的，
         现在不行了 —— 他在里面开了布线，外面那张小图要跟着，重开弹层也得还是那样）。 */
      wireOn = _view0 ? !!_view0.wire : false;
      var _wb = document.getElementById('pv3dWire');
      if (_wb) _wb.classList.toggle('did', wireOn);
      pv3dApplyWire();
      /* 🆕 「显示原点」（阿聪 2026-10-14）—— **每次打开都从"关"开始**
         （阿聪 要的默认关：别一上来就挡视线）。
         ⚠️ **不像布线 / 白模那样记进 `_view0`** —— 那两样挂的时候**外面那张小图也要跟着**，
            所以得存；原点只是一时看一眼的辅助线，缩略图上也用不着，不必存。
         顺手清掉上一个模型留下的那组轴（`pv3dApplyOrigin` 先清再（不）画）。 */
      originOn = false;
      var _orb = document.getElementById('pv3dOrigin');
      if (_orb) _orb.classList.remove('did');
      pv3dApplyOrigin();
      /* 🆕 「显示面朝向」（阿聪 2026-10-15）—— 跟「显示原点」一个规矩：
         **每次打开都从"关"开始**（它是一次性的排查工具，不该赖着不走）。
         顺手把上一个模型留下的 shader 改动还原掉（关着时 `pv3dApplyFacing` 就是"还原"）。 */
      facingOn = false;
      var _fcb = document.getElementById('pv3dFacing');
      if (_fcb) _fcb.classList.remove('did');
      pv3dApplyFacing();
      /* 🆕 「平面着色」（阿聪 2026-10-15）—— ⚠️ 跟上面两样**不一样**：
         它是"常态显示方式"、**默认开**，所以**每次都置回开**（不是"每次从关开始"）。
         ⚠️ 放这儿（作用在模型**原生材质**上）就够 —— 后面 UV 检查 / 白模那几套改的是
            贴图 / 换材质，跟 `flatShading` 不碰同一个槽；换出去的是不吃光照的材质，
            给它设了也看不出来（属正常）。 */
      /* 🆕 「平面着色」—— ⚠️ 2026-10-15 改：**默认改成"关"**（阿聪：「以后**默认开自动平滑**」，
         常态那档让给自动平滑；平面着色**功能留着**，要看面级问题的时候点一下）。 */
      flatOn = false;
      var _flb = document.getElementById('pv3dFlat');
      if (_flb) _flb.classList.toggle('did', flatOn);
      pv3dApplyFlat();
      /* 🆕 「自动平滑」（阿聪 2026-10-15）—— 默认开，但**开不开由宿主说了算**：
         **2.1 那步默认不跑**（见 `网站/app.js` 的 `NO_AUTO_SMOOTH_STEPS` —— 那份 Tripo 高模
         本来就全平滑，跑了零收益、还每次卡十几秒）。
         ⚠️ 宿主**没传**这个字段时按"开"（别的宿主 / 老调用照旧）。
         ⚠️ 只关"默认" —— **开关本身留着**，在 2.1 手动点一下还是能开。 */
      autoSmoothOn = !(opts && opts.autoSmoothDefaultOn === false);
      var _asb = document.getElementById('pv3dSmooth');
      if (_asb) _asb.classList.toggle('did', autoSmoothOn);
      pv3dApplyAutoSmooth();
      /* UV 检查：默认关；但那一步自己要求"默认开"时就开着进来
         （阿聪 2026-10-04：「2.3 特殊点，预览是默认打开这个模式的」） */
      /* ⚠️ **能开才谈得上开没开**：`opts.uvCheck` = 这一步有没有 UV。宿主存的那份
         view 里说"开着 UV"、可这一步压根没 UV，得忽略掉（否则会拿个空色块去糊）。 */
      uvCheckOn = _view0
        ? !!(opts && opts.uvCheck && _view0.uv)
        : !!(opts && opts.uvCheck && opts.uvDefaultOn);
      var _ub = document.getElementById('pv3dUV');
      if (_ub) _ub.classList.toggle('did', uvCheckOn);
      pv3dApplyUVCheck();
      /* 法线：**默认就是开着的** —— 它本来就在模型上（见上面那段的注释）。
         只有这一步真带这张贴图（`opts.bakeMaps`）才碰按钮，别的步别乱标。 */
      if (opts && opts.bakeMaps){
        /* 🔴 2026-10-06 阿聪：「**因为是烘焙法线嘛，所以我希望这里应该输出的是
           默认开启纯法线的 glbview**」。
           对：3.1 的产物是「**白模 + 法线图**」—— 默认看"模型原样"就是个光溜溜的
           白模，**看不出这一步到底烘出来了什么**。所以这一步默认亮**「纯法线」**
           那格（把法线贴图本身铺上去），一眼就是"我烘的这张图"。
           ⚠️ 「能开」(`bakeMaps`) 和「默认开」(`bakeRawOn`) 是**两件事** ——
              跟 2.3 的 `uvCheck` / `uvDefaultOn` 一个道理，别合并成一个参数。 */
        /* 同上：宿主记过的样子优先（`'raw'`/`'off'`/`''` → `'n-raw'`/`'n-off'`/`''`） */
        if (opts && opts.bakeLocked){
          /* 🆕 2026-10-15 **锁死的步**（2.2）—— 固定「关掉法线」那一档，
             **不看 `_view0`**（他都切不动，记下来的必然是脏的）。
             见 `网站/app.js` 的 `stepNoNormal` 那段（为什么要锁：那一步本来就没法线贴图）。 */
          bakeView = 'n-off';
        } else if (_view0){
          bakeView = _view0.bake === 'raw' ? 'n-raw' : (_view0.bake === 'off' ? 'n-off' : '');
        } else {
          /* 🆕 2026-10-15：这一步**默认看「关掉法线」**（2.2，见 `网站/app.js` 的 `stepNoNormal`）——
             跟 `bakeRawOn`（3.1 默认"纯法线"）是一对，只是默认的那档不同。
             ⚠️ 它是"**默认**"、**不是"锁死"** —— 打开时定这一档，之后用户照样能切
                （锁不锁看 `opts.bakeLocked` 那条，那是另一回事，跟这个不混）。 */
          bakeView = (opts && opts.bakeOffOn) ? 'n-off'
                   : ((opts && opts.bakeRawOn) ? 'n-raw' : '');
        }
        pv3dMarkBakeBtns();
        pv3dApplyBakeMaps();
      }
      /* 🆕 「白模」（阿聪 2026-10-14）—— 宿主记过的样子优先，没有才用"这一步默认"
         （2.1 / 2.2 默认开，见 `网站/app.js` 的 `stepWhiteDefaultOn`）。
         ⚠️ 它**没有"能不能开"这一说**（哪一步都能开），所以不像 UV 检查那样先判 `opts.uvCheck`。
         🔴 **必须排在 uv / 法线之后**（见 `pv3dSetWhite` 上头那段）——
            `pv3dSetBakeMaps` 会把"当前样子"存成快照，白模先应用的话它存下去的就是个空壳。 */
      /* ⚠️ `white` **缺失**（老产出记的那份 `view` 里没这个字段）时要当"没记过"、
         回落到"这一步的默认" —— 不能 `!!_view0.white` 一把梭：那样老产出的默认永远是"关"
         （2026-10-14 实测踩到，阿聪 报"刷新后 2.1 依旧不是默认白模"就是这个）。
         宿主（`网站/app.js` 的 `m3dViewFull`）那边也会补，这儿是**兜底**（别的宿主没补时）。 */
      whiteOn = (_view0 && _view0.white !== undefined)
        ? !!_view0.white
        : !!(opts && opts.whiteDefaultOn);
      var _whb = document.getElementById('pv3dWhite');
      if (_whb) _whb.classList.toggle('did', whiteOn);
      pv3dApplyWhite();
      /* 「显示骨架」：**能不能点看这个模型自己有没有骨头**（不看步骤，见上面那段）。
         一直在、用不上就灰着 —— 跟「UV 检查」「纯法线」一个规矩。
         ⚠️ 顺序跟界面一致：布线 → UV → 法线 → **骨架**（= 能力解锁的先后）。 */
      var _boneN = pv3dFindBones(obj).length;
      /* 骨架那张卡（两格）：判据**看模型自己有没有骨头**，不看步骤。
         每次打开从"两格都不亮"（不画骨架）开始。 */
      /* 默认哪一档 —— 由宿主传 `opts.skelView` 决定（4.1 传 `'bone'`：
         那一步的产物就是"带骨架的 glb"，默认看原样是看不出骨架的 ——
         跟 3.1 默认开"纯法线"一个道理）。不传 = 不画。 */
      skelView = _view0 ? (_view0.skel || '') : ((opts && opts.skelView) || '');
      var _sbtn = document.getElementById('pv3dSkel');
      if (_sbtn){
        _sbtn.disabled = !_boneN;
        _sbtn.title = _boneN
          ? '左：画出骨头（' + _boneN + ' 根）看摆在哪、朝向正不正 ｜ 右：连名字一起标出来，'
            + '核骨名对不对（接引擎那步用）｜ 一次只看一个；两格都不亮 = 不画骨架；'
            + '再点已经亮着的那格 = 取消'
          : '这个模型里没有骨架 —— 要到「4.1 动画—生成骨架」绑过骨才有';
      }
      pv3dMarkSkelBtns();
      pv3dApplySkeleton();
      /* 「姿态模式」—— 出不出来看两件事：
         ① **这一步得允许**（宿主传 `opts.poseMode`）—— 阿聪：「**glbview 还是专注
            模型查看吧，就不塞入操作了**」，所以别的步骤**压根看不到这个入口**。
         ② 这个模型**得有骨头**（没骨就没得拖）。
         ⚠️ 每次打开都**归零**：弹层是复用的，上一次那个姿势在 `pv3dClose` 里已经
            还原过了，这儿只要把状态清掉、界面标回"没开"就行。 */
      poseOn = false; poseBone = null; poseBind = null; poseTool = 'rotate';
      poseAllow = !!(opts && opts.poseMode);
      /* 🎨 「权重图」—— 判据是**这个模型有没有蒙皮**（没权重就没得画）。
         ⚠️ 跟姿态模式不一样：**不用宿主传开关** —— 它是"看"，属于 glbview 的本职
            （阿聪：「能做个权重图的显示吗 **glbview**」）。所以只要有蒙皮就放开。 */
      weightOn = false;
      var _hasSkin = false;
      obj.traverse(function(o){
        if (o.isSkinnedMesh && o.skeleton && o.skeleton.bones && o.skeleton.bones.length) _hasSkin = true;
      });
      var _wbtn = document.getElementById('pv3dWeight');
      if (_wbtn){
        _wbtn.hidden = !_hasSkin;
        _wbtn.disabled = !_hasSkin;
        _wbtn.classList.remove('on');
        _wbtn.title = _hasSkin
          ? '挑一根骨 → 看它影响模型上哪些地方（红=吃满、蓝=没吃到）'
          : '这个模型没有蒙皮 —— 要到「4.2 动画—生成蒙皮权重」蒙过才有';
      }
      var _pbtn = document.getElementById('pv3dPose');
      if (_pbtn){
        _pbtn.hidden = !poseAllow;
        _pbtn.disabled = !_boneN;
        _pbtn.title = _boneN
          ? '进去就能拖着骨头摆姿势，看蒙皮在这个姿势下变不变形（这个模型有 '
            + _boneN + ' 根骨）｜ 进去后画布**右上角**有「旋转 / 移动」，快捷键 W / E'
          : '这个模型里没有骨架 —— 要到「4.1 动画—生成骨架」绑过骨才拖得动';
      }
      pv3dSyncPoseUI();
      /* 播放动画（4.3 之后的产出才带）：
         **判据看模型自己带没带 `animations`**（跟骨架一个规矩，不看步骤）。
         默认**停着** —— 一打开就动的话，模型表面的细节根本看不清。
         ⚠️ 用 `timeScale` 播 / 停，**别用 stop() + play()** ——
            那样每点一次都会**从头开始**，看着像"卡了一下"。 */
      animModeOn = false;          // 退出动画模式（连带把浮层收起来，见下面的 sync）
      pv3dAnimOn = false;
      pv3dRestMode = false;        // 换模型（或重开）→ 先不清场，下面有动作才置 true
      pv3dClipN = 0;
      pv3dClips = [];
      pv3dClipIdx = 0;
      if (pv3dMixer){ pv3dMixer.stopAllAction(); pv3dMixer = null; }
      var _abtn = document.getElementById('pv3dAnim');
      if (_abtn){
        _abtn.classList.remove('on');
        _abtn.innerHTML = '&#9654; 播放';
      }
      /* 「动画模式」那个开关也先藏起来 —— 要等模型加载完才知道有没有动作。
         ⚠️ 这儿要**自己调一次 sync**：下面没动作的分支不会走到它。 */
      var _amb0 = document.getElementById('pv3dAnimMode');
      if (_amb0){ _amb0.hidden = true; _amb0.classList.remove('did'); }
      pv3dSyncPoseUI();
      var _clips = (g && g.animations) || [];
      pv3dClipN = _clips.length;
      if (_clips.length && _abtn){
        pv3dMixer = new THREE.AnimationMixer(obj);
        pv3dClips = _clips;
        pv3dClipIdx = 0;
        pv3dMixer.clipAction(_clips[0]).play();
        pv3dMixer.timeScale = 0;                 // 先停着，点了才播
        /* 打开就是静止姿势（模型自带的那个）—— 不套动画第 0 帧。
           要看动起来，进动画模式点「播放」。 */
        pv3dRestMode = true;
        _abtn.title = '这个模型带了 ' + _clips.length + ' 段动作（'
                    + (_clips[0].name || '未命名') + '，'
                    + _clips[0].duration.toFixed(2) + ' 秒）—— 点一下播 / 再点停';
        /* 🎬 **有动作 → 左上角那块浮层露出来**（这就是阿聪说的"动画模式"）。
           ⚠️ 顺带把速度挡位按**当前值**点回来（`pv3dAnimSpeed` 不跟模型重置，
              所以这儿是"把上次选过的那个反映出来"）。 */
        /* 有动作 → **「动画模式」那个开关露出来**（浮层本身**不直接露** ——
           它跟着模式开关走，见 `pv3dSyncPoseUI`）。 */
        var _amb = document.getElementById('pv3dAnimMode');
        if (_amb) _amb.hidden = false;
        var _actl = document.getElementById('pv3dAnimctl');
        if (_actl){
          Array.prototype.forEach.call(_actl.querySelectorAll('.pv3d-spd'), function(x){
            x.classList.toggle('on', parseFloat(x.getAttribute('data-s')) === pv3dAnimSpeed);
          });
          /* 🎞 动作切换那排 —— **按模型自己的段数生成**（不写死三个）。
             只有一段就不显示（那时候换也没得换）。
             ⚠️ **要排序**：glb 里 animations 的顺序是 Blender 导出时定的，
                实测是**字母序**（`Loop_idle` / `Loop_run` / `Loop_walk`）——
                直接铺出去就是"待机、跑步、走路"，跟人想的顺序不一样。
                `data-i` 仍然指向**原始下标**（那才是 mixer 要的索引）。 */
          var _abr = document.getElementById('pv3dActBtns');
          if (_abr){
            var _ORD = {'待机':0, '走路':1, '跑步':2};
            _abr.innerHTML = '';
            _abr.hidden = _clips.length < 2;
            _clips.map(function(c, i){
              var lab = pv3dClipLabel(c.name);
              return { c: c, i: i, lab: lab, o: (_ORD[lab] == null ? 9 : _ORD[lab]) };
            }).sort(function(x, y){ return x.o - y.o; })
              .forEach(function(it){
                var b = document.createElement('button');
                /* 亮的是**真正在播的那一段**（`pv3dClipIdx`），不是"排第一个的" ——
                   万一模型里没有 idle，排头那个也不是它在播。 */
                b.className = 'pv3d-posebtn pv3d-act' + (it.i === pv3dClipIdx ? ' on' : '');
                b.setAttribute('data-i', it.i);
                /* 中文标签认不出 → **显示原名**（`pv3dClipNiceName` 去掉前缀）。
                   别退回「动作 N」：那是"这一格是第几个"，不是"这是个什么动作"。 */
                b.textContent = it.lab || pv3dClipNiceName(it.c.name);
                b.title = it.c.name + '（' + it.c.duration.toFixed(2) + ' 秒）';
                _abr.appendChild(b);
              });
          }
          pv3dSyncPoseUI();             // 露哪个按钮 / 挪谁的位置，统一在那边刷
        }
      } else if (_abtn){
        _abtn.title = '这个模型里没有动作 —— 要到「4.3 动画—动作匹配」套过动作才有';
      }

      // 再补一帧：等浏览器把布局彻底排完，double check 一次（不稳的话这行兜底）
      requestAnimationFrame(function(){
        fitPv3d();
        frame(obj);
      });
    }, undefined, function(err){
      msg.textContent = '这个模型打不开（' + (err && err.message ? err.message : '未知原因') + '）';
    });
  }catch(e){
    // 跟上面那条（加载失败）措辞统一 —— 都是「打不开 + 真实原因」，别一句开发话术糊过去
    msg.textContent = '这个模型打不开（' + ((e && e.message) || '未知原因') + '）';
    pv3d.hidden = false;
  }
};

// 调试用：读当前相机的真实位置和目标点（拿来验复位有没有真的生效）
function n3(v){ return +v.toFixed(3); }      // 三位小数，够看又不啰嗦
window.pv3dDebug = function(){
  if (typeof camera === 'undefined' || !camera) return null;
  return {
    cam: camera.position.toArray().map(function(v){ return +v.toFixed(3); }),
    target: controls.target.toArray().map(function(v){ return +v.toFixed(3); }),
    zoom: +camera.zoom.toFixed(3),
    hasModel: typeof holder !== 'undefined' && holder && holder.children.length > 0,
    /* 🆕 骨架（2026-10-06）—— 查「显示骨架」到底画出来没有。
       ⚠️ **读真值，别读按钮**（CLAUDE.md 那条踩坑：界面亮着≠材质对）。
       `bones` = 模型自带几根骨；`skelParts` = 现在**场上真画着**几个骨架零件
       （关节球 + 骨干线），关掉时该是 0。 */
    /* 🆕 「显示原点」（2026-10-14）—— 查"三轴到底画在哪"，读真值不读按钮。
       `originOn` = 开关状态；`originParts` = 场上**真画着**几个轴（关掉该是 0）；
       `originPos` = 画的那个点；`modelOrigin` = 模型自己的原点（两个应当一致）。 */
    originOn: (typeof originOn === 'undefined') ? false : originOn,
    originParts: (function(){
      var n = 0;
      if (typeof scene === 'undefined' || !scene) return n;
      scene.traverse(function(o){ if (o.userData && o.userData.__origin) n++; });
      return n;
    })(),
    originPos: (function(){
      var g = null;
      if (typeof scene === 'undefined' || !scene) return null;
      scene.traverse(function(o){ if (!g && o.userData && o.userData.__origin) g = o; });
      return g ? g.position.toArray().map(n3) : null;
    })(),
    modelOrigin: (function(){
      if (typeof pv3dObj === 'undefined' || !pv3dObj) return null;
      var p = pv3dModelOrigin();
      return p ? p.toArray().map(n3) : null;
    })(),
    /* 那三根轴是不是**都开了穿透**（`depthTest:false`）。
       不穿透 = 原点落在身体里时被网格挡死 = 白做（跟 `skelXray` 同一个判据）。 */
    originXray: (function(){
      var seen = 0, xray = 0;
      if (typeof scene === 'undefined' || !scene) return null;
      scene.traverse(function(o){
        var g = o.userData && o.userData.__origin ? o : null;
        if (!g) return;
        g.children.forEach(function(c){
          [c.line, c.cone].forEach(function(part){
            if (!part || !part.material) return;
            seen++; if (part.material.depthTest === false) xray++;
          });
        });
      });
      return seen ? { seen: seen, xray: xray } : null;
    })(),
    bones: (typeof pv3dObj !== 'undefined' && pv3dObj) ? pv3dFindBones(pv3dObj).length : 0,
    /* 骨架那张卡的当前档：`''` = 不画 ｜ `'bone'` = 画骨头 ｜ `'name'` = 画骨头 + 标名字 */
    skelView: skelView,
    skelOn: skelOn(),
    /* 骨名（2026-10-06 加）—— 查「显示骨名」到底标出来没有 */
    boneNameOn: boneNameOn(),
    boneLabelN: pv3dBoneLabels.length,
    skelParts: (function(){
      var n = 0;
      if (typeof pv3dObj === 'undefined' || !pv3dObj) return n;
      pv3dObj.traverse(function(o){ if (o.userData && o.userData.__skel) n++; });
      return n;
    })(),
    /* 骨架零件是不是**都开了穿透**（`depthTest:false`）。
       不穿透 = 骨头全长在身体里、被网格挡得死死的 = 白做（这个功能最大的失败模式）。 */
    skelXray: (function(){
      var seen = 0, xray = 0;
      if (typeof pv3dObj === 'undefined' || !pv3dObj) return null;
      pv3dObj.traverse(function(o){
        if (!(o.userData && o.userData.__skel) || !o.material) return;
        seen++; if (o.material.depthTest === false) xray++;
      });
      return seen ? { seen: seen, xray: xray } : null;
    })(),
    /* 「骨架跟模型配不配」—— 两个盒子的范围摆一起看。
       骨架只覆盖上半身 / 缩在中间一小团 / 捅到模型外面，一眼就出来。
       （光看截图不算数：线细、又被贴图压着，看不清是"没画"还是"看不清"。） */
    modelBox: (function(){
      if (typeof pv3dObj === 'undefined' || !pv3dObj) return null;
      var bb = pv3dModelBox(pv3dObj);     // 🔴 会算上蒙皮，不是裸 geometry 盒
      if (bb.isEmpty()) return null;
      return { min: bb.min.toArray().map(n3), max: bb.max.toArray().map(n3) };
    })(),
    boneBox: (function(){
      if (typeof pv3dObj === 'undefined' || !pv3dObj) return null;
      var bones = pv3dFindBones(pv3dObj);
      if (!bones.length) return null;
      var bb = new THREE.Box3();
      bones.forEach(function(b){
        bb.expandByPoint(b.getWorldPosition(new THREE.Vector3()));
      });
      return { min: bb.min.toArray().map(n3), max: bb.max.toArray().map(n3), n: bones.length };
    })(),
    /* 每根骨在**模型相对身高**上的落点（0 = 脚底，1 = 头顶）——
       查"骨架摆得对不对"最直接的一把尺子。比看包围盒准得多：
       包围盒会被"骨的端点在哪"骗（glTF 里 bone 就是个节点、**没有长度**，
       所以 `Head` 的原点在脖子顶端、量出来只有 64%，可它的末端其实在头顶）。
       拿它对一下就知道 Q 版的脖子该在 50~75%（写实模型在 80% 上下）。 */
    /* 动画（4.3 之后的产出才有）—— 查"播放动画"到底动没动。
       ⚠️ **`animTime` 是判"真的在走"的关键**：光看按钮亮不亮不算数。 */
    /* 🎨 权重图 —— `weightMeshes` = 现在**真画着权重色**的网格数（0 = 没画） */
    weightOn: weightOn,
    weightMeshes: (function(){
      var n = 0;
      if (typeof pv3dObj !== 'undefined' && pv3dObj){
        pv3dObj.traverse(function(o){ if (o.__wOrigMat) n++; });
      }
      return n;
    })(),
    animClips: pv3dClipN,
    animOn: pv3dAnimOn,
    animTime: pv3dMixer ? +pv3dMixer.time.toFixed(3) : null,
    boneProfile: (function(){
      if (typeof pv3dObj === 'undefined' || !pv3dObj) return null;
      var bones = pv3dFindBones(pv3dObj);
      if (!bones.length) return null;
      var bb = pv3dModelBox(pv3dObj);
      var ylo = bb.min.y, h = Math.max(bb.max.y - ylo, 1e-6);
      var hw = Math.max((bb.max.x - bb.min.x) / 2, 1e-6);
      return bones.map(function(b){
        var p = b.getWorldPosition(new THREE.Vector3());
        return {
          n: b.name,
          h: +((p.y - ylo) / h).toFixed(3),   // 相对身高：0 = 脚底，1 = 头顶
          x: +(p.x / hw).toFixed(3)           // 相对半宽：**1 = 贴着模型左右边缘**
        };
      });
    })(),
    /* 🆕 材质上到底挂了什么 —— 查"切来切去之后对不对"用（2026-10-05 加的：
       来回切一遍之后渲染坏了，光看按钮"亮哪半"看不出来，得读材质真值）。 */
    mats: (function(){
      var out = [];
      if (typeof pv3dObj === 'undefined' || !pv3dObj) return out;
      pv3dObj.traverse(function(o){
        if (!o.isMesh || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
          if (out.length >= 4) return;
          out.push({
            map: !!m.map, normalMap: !!m.normalMap, aoMap: !!m.aoMap,
            emissiveMap: !!m.emissiveMap,
            color: m.color ? '#' + m.color.getHexString() : null,
            emissive: m.emissive ? '#' + m.emissive.getHexString() : null,
            metalness: (typeof m.metalness === 'number') ? +m.metalness.toFixed(2) : null,
            roughness: (typeof m.roughness === 'number') ? +m.roughness.toFixed(2) : null,
            nmCS: m.normalMap ? m.normalMap.colorSpace : null,
            aoCS: m.aoMap ? m.aoMap.colorSpace : null
          });
        });
      });
      return out;
    })()
  };
};
/* 弹层里现在"看成了什么样" —— 一个**干净的读数**（2026-10-06 加）。
   ⚠️ 跟 `pv3dDebug()` 分工不一样：那个是**调试用**（字段多、随功能增删）；
      这个是**契约** —— 只放"会影响外面那张小图"的几样，宿主拿它存到产出上。 */
window.pv3dView = function(){
  return {
    uv: !!uvCheckOn,
    /* 🆕 2026-10-14：**「白模」也进契约**（阿聪：「进记忆」）——
       2.1 / 2.2 本来就默认是它，更要记住用户在里面切成了什么。 */
    white: !!whiteOn,
    /* 🔴 `wv` = "这份记录是**哪一版格式**写的"。见 `网站/app.js` 的 `m3dViewFull` ——
       它靠这个认出"白模刚做出来那个窗口期"写下的脏 `white:false`。
       **改动这个对象的字段就 +1**（不是改画法，是改记录格式）。 */
    wv: 2,
    bake: bakeView === 'n-raw' ? 'raw' : (bakeView === 'n-off' ? 'off' : ''),
    skel: skelView || '',
    wire: !!wireOn
  };
};

/* ── 「这个产出被看成了什么样」→ 缩略图画哪一版 ────────────────────────
   ⚠️ **收在这儿是为了只留一份**：网站（`网站/app.js` 的 `m3dRow`）和单元页
      （`modules/unitkit/card.js`）的产出卡片是**两份独立实现** ——
      2026-10-06 就因为"只改了一边"白绕过好几轮（阿聪：「预览还是没有骨架啊」）。
      这个映射两边都要用，放中间这一份，谁也别抄。

   `v` 的形状就是 `window.pv3dView()` 给的那个：
      { uv: bool, bake: '' | 'raw' | 'off', skel: '' | 'bone' | 'name', wire: bool }

   🔑 **ModeKey 跟老的三种（`''` / `'uv'` / `'normal'` / `'skel'`）完全兼容** ——
      老缓存不会因为这次改动白重出一遍。
   ⚠️ `bake:'off'`（关掉法线）和 `''`（原样）**算同一版**：小图上看着就是一样的，
      给它俩分两个 key 只会白重出一张长得一样的图。
   ⚠️ `skel:'name'` 和 `'bone'` 同理 —— 小图只有 256px，标骨名糊成一团，都不标。 */
/* 🆕 2026-10-15：**把 A 模型自带的贴图，搬进 B 模型** —— 3.2「用模型自带的贴图」要用。
   起因：**3.1 烘完法线后把低模的材质整块扔了**（`bake_blender.py` 干的，那边不改）；
        而**颜色贴图本来就在更上游（2.2）那份产出里** —— 所以在前端把两份合起来：
        **B 的几何 + 法线（3.1 烘好的） ＋ A 的颜色贴图（2.2 带的）**。

   ⚠️ **为什么放 glbview**：这儿**已经有 three 的加载/导出**（`GLTFLoader` / `GLTFExporter`），
      而 `网站/app.js` 是普通脚本、**够不到 three**。新建一个模块也是同样这几行代码，不如就近放。
   ⚠️ 它跟上面"**看**模型"那摊事不同类（这个是"**改**模型"），所以**单独一个函数、上面那些一行不动**。
   用法：`window.pv3dBakeTex(lowUrl, texUrl)` → `Promise<Blob>`（glb） */
window.pv3dBakeTex = function(baseUrl, extraUrl){
  return new Promise(function(resolve, reject){
    var L = new GLTFLoader();
    Promise.all([
      new Promise(function(r, j){ L.load(baseUrl,  r, undefined, j); }),
      new Promise(function(r, j){ L.load(extraUrl, r, undefined, j); })
    ]).then(function(g){
      /* 🔴 2026-10-15 **反过来用了**（第一版是"以 3.1 那份为底、往上挂颜色"，实测**没颜色**）：
         原因：**3.1 那份（SP 导出）没有 UV** —— 它材质都被扔了（`bake_blender.py` 干的），
         贴图挂上去也**没有 UV 坐标可贴**，所以看着还是白模。
         👉 改成 **以 `baseUrl`（2.2 那份）为底** —— 它**一定有 UV、有颜色、几何也是同一份**
            （2.2 出低模 → 3.1 只是拿它烘法线，几何没变）；
            再把 `extraUrl`（3.1 那份）里**烘好的法线贴图**挂上去。
         ⇒ 结果：**UV（2.2 的）＋ 颜色（2.2 的）＋ 法线（3.1 烘的）**，三样齐。 */
      var keep = g[0].scene || g[0].scenes[0];      // 底：2.2 那份（几何 + UV + 颜色）
      var extra = g[1].scene || g[1].scenes[0];     // 加料：3.1 那份（法线贴图）
      /* ① 从"加料那份"里取法线贴图（取**第一张**找到的 —— 低模一般就一套材质） */
      var nm = null;
      extra.traverse(function(o){
        if (nm || !o.isMesh || !o.material) return;
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(mat){
          if (!nm && mat.normalMap) nm = mat.normalMap;
        });
      });
      /* ② 挂到"底那份"的每个材质上 —— 🔴 **只补 `normalMap`，`map`（颜色）一个都不碰** */
      if (nm){
        keep.traverse(function(o){
          if (!o.isMesh || !o.material) return;
          (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(mat){
            if (mat.normalMap !== nm){ mat.normalMap = nm; mat.needsUpdate = true; }
          });
        });
      }
      /* ③ 导出成 glb（binary）→ 包成 Blob（`parse` 给的是 ArrayBuffer） */
      new GLTFExporter().parse(keep, function(r){
        resolve(new Blob([r], { type: 'model/gltf-binary' }));
      }, function(e){ reject(e); }, { binary: true });
    }).catch(reject);
  });
};

window.pv3dViewMode = function(v){
  if (!v) return '';
  /* 🆕 白模也占**主位**（它跟 uv 互斥，谁在算谁）—— 优先级：uv > white > normal。
     ⚠️ `'white'` 是个**新 key**，老缓存（`''`/`'uv'`/`'normal'`/`'skel'`）不受影响。 */
  var s = v.uv ? 'uv' : (v.white ? 'white' : (v.bake === 'raw' ? 'normal' : ''));
  /* 叠加项按**能力解锁的先后**拼：布线（建模就有）→ 骨架（4.1 才有的）。
     顺序**固定**就够用了（同一份状态永远算出同一个 key，缓存才判得准），
     拼出来长这样：`'skel'` / `'wire+skel'` / `'normal+wire'`。 */
  if (v.wire) s = s ? s + '+wire' : 'wire';
  if (v.skel) s = s ? s + '+skel' : 'skel';
  return s;
};
/* 同一份状态 → 直接喂 `studioThumb` 的 opts（决定"怎么画"） */
window.pv3dViewThumbOpts = function(v){
  return {
    uv: !!(v && v.uv),
    white: !!(v && v.white),          // 🆕 白模（见 `pv3dSetWhite`）
    normal: !!(v && v.bake === 'raw'),
    skel: !!(v && v.skel),
    wire: !!(v && v.wire)
  };
};

/* 🦴 拖动骨骼那格的调试读数 —— 给 `modules/glbview/check_glbview_pose.js` 用。
   跟 `pv3dDebug()` 分开：那个是通用读数（字段多、随功能变），
   这个只服务这一格，读数也**只读真值**（骨骼的实际旋转角），不读按钮亮不亮。 */
window.pv3dPoseDebug = function(){
  var moved = null;
  if (poseBind){
    var mx = 0;
    poseBind.forEach(function(r){
      var d = r.b.quaternion.angleTo(r.q);        // 跟**原始姿势**差多少
      if (d > mx) mx = d;
    });
    moved = +(mx * 180 / Math.PI).toFixed(3);     // 转成"度"好读
  }
  /* 挑一根**有名字的**骨当"探针"（优先 `Hips`）—— 下面的 `q` 和 `screenXY`
     都是报它的。脚本拿这两样：屏幕坐标去点它的关节球，四元数比对还原。 */
  var probe = null, probeXY = null;
  if (typeof pv3dObj !== 'undefined' && pv3dObj){
    var bs = pv3dFindBones(pv3dObj);
    if (bs.length){
      probe = bs[0];
      for (var pi = 0; pi < bs.length; pi++){
        if (bs[pi].name === 'Hips'){ probe = bs[pi]; break; }
      }
      try{
        var wv = probe.getWorldPosition(new THREE.Vector3()).project(camera);
        var rc2 = renderer.domElement.getBoundingClientRect();
        if (rc2.width && rc2.height){
          probeXY = { name: probe.name,
                      x: Math.round(rc2.left + (wv.x + 1) / 2 * rc2.width),
                      y: Math.round(rc2.top + (-wv.y + 1) / 2 * rc2.height) };
        }
      }catch(e){}
    }
  }
  return {
    on: poseOn,                                    // 姿态模式开着没
    tool: poseTool,                                // 'rotate' / 'move'
    bone: poseBone ? (poseBone.name || '?') : null,
    hasGizmo: !!(poseTC && poseTC.visible && poseTC.object),
    bind: poseBind ? poseBind.length : 0,          // 记了几根骨的原始姿势
    movedDeg: moved,                               // 最大偏了多少度（null = 没在拖）
    /* 挑一根**有名字的**骨，报它当前的**局部四元数** ——
       脚本拿它比对"关掉之后到底还原没还原"（最硬的那条判据：
       拖动前的 q 和关掉之后的 q 必须一模一样）。 */
    q: probe ? { name: probe.name,
                 q: probe.quaternion.toArray().map(function(x){ return +x.toFixed(6); }) }
             : null,
    /* 那根骨在**屏幕上的位置**（CSS 像素）—— 脚本拿它去 `Input.dispatchMouseEvent`
       点那颗关节球（跟人手点的**就是同一处**）。 */
    screenXY: probeXY
  };
};

/* 🎨 权重图的读数 —— 给 `modules/glbview/check_glbview_pose.js` 用。
   ⚠️ **不能只看"开关亮不亮"**：开关亮了但一个网格都没着色（没挑骨头 / 没蒙皮）
      也是白搭。这儿数**顶点色里红/蓝/中间色各多少**，那才是真值。
      · `cold` 蓝 = 权重 0（这根骨没吃到）
      · `hot`  红 = 权重 1（吃满）
      · `mid`  中间色 = 过渡
   ⚠️ 顶点可能几十万 → **每 37 个抽样一个**（数量级够用，别把主线程焊死）。 */
window.pv3dWeightStats = function(){
  var out = { meshes: 0, total: 0, hot: 0, cold: 0, mid: 0, bone: poseBone ? poseBone.name : null };
  if (typeof pv3dObj === 'undefined' || !pv3dObj) return out;
  pv3dObj.traverse(function(o){
    if (!o.__wOrigMat || !o.geometry) return;
    var c = o.geometry.attributes.color;
    if (!c) return;
    out.meshes++;
    for (var i = 0; i < c.count; i += 37){
      var r = c.getX(i), b = c.getZ(i);
      out.total++;
      if (b > 0.9 && r < 0.1) out.cold++;
      else if (r > 0.9 && b < 0.1) out.hot++;
      else out.mid++;
    }
  });
  return out;
};

window.pv3dClose = function(){
  /* 🔴 顺序要紧：**先把状态读出来**（`pv3dView` 读的就是下面要清的这几个量），
     再清场景，最后才回报给宿主 ——
     阿聪要的「里面显示是什么、外面也跟着显示」就靠最后这一句。 */
  var _vNow = window.pv3dView();
  pv3d.hidden = true;
  /* 关掉就把动画停了、引用也清掉 —— 不然 mixer 还在后台空转，
     而且它抓着的是已经被 `clearHolder` dispose 掉的场景。 */
  if (pv3dMixer){ pv3dMixer.stopAllAction(); pv3dMixer = null; }
  pv3dAnimOn = false;
  pv3dRestMode = false;
  /* 🔴 还原姿势要**赶在清场景之前** —— 骨头还在才 copy 得回去。
     不还原的话，下次打开同一个模型会带着上次拖歪的样子，看着像模型坏了。 */
  pv3dPoseRestore();
  /* 权重图也要在清场景之前擦掉（它改的是几何体的 color 属性和材质） */
  pv3dClearWeightMap();
  weightOn = false;
  var _wb = document.getElementById('pv3dWeight');
  if (_wb) _wb.classList.remove('on');
  if (holder) clearHolder();
  /* 取出来再清 —— `pv3dClose` 可能被调两次（Esc + 点背景），别回报两遍 */
  if (pv3dOnClose){ var _cb = pv3dOnClose; pv3dOnClose = null; _cb(_vNow); }
};


/* ═══════════ 3D 渲染台（第 5、6 站用）═══════════
   页面里嵌一个真能转、能调、能出图的 3D 台 —— 阿聪 2026-10-03：
   「3·6也跑简单的流程啊，你看混元 tripo 那些网站都能脱离引擎和 SP 做，为什么我们不行」。

   为什么是**共用一个**：WebGL context 有数量上限，给 6 个步骤各建一个渲染器
   迟早会撞上「Too many active WebGL contexts」。所以只建一次，
   canvas 在几个步骤页之间**搬**（appendChild 换父节点不会丢 context）。

   对外接口挂在 window 上（主代码是 IIFE，拿不到 module 里的东西）：
     studioMount(hostId, url)   把台子搬到某个容器；url 换了就重新加载模型
     studioSet(key, val)        调材质/灯光/背景/曝光/暗角
     studioCloth(from, to)      按高度范围高亮「会飘的部件」
     studioPlay(on)             播 / 停 动画
     studioShot(size, cb)       出图（返回 PNG 的 dataURL）
     studioInfo()               当前状态（给界面显示用） */

var ST = {
  renderer: null, scene: null, camera: null, controls: null, holder: null,
  mixer: null, clock: null, url: '', host: null, raf: 0,
  cfg: { material: 'keep', light: 'three', bg: '#f2ece2', exposure: 1.0, vignette: 0.35 },
  cloth: null,
  lights: [],
  played: false
};

function stInit(){
  if (ST.renderer) return;
  var r = new THREE.WebGLRenderer({
    antialias: true, alpha: false,
    preserveDrawingBuffer: true      // 🔴 不给这个，toDataURL 导出来是全黑的
  });
  r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  r.shadowMap.enabled = true;
  r.shadowMap.type = THREE.PCFSoftShadowMap;
  /* ⚠️ 色调映射交给 **OutputPass** 统一做（见下面建 composer 那段）——
     这儿原来开着 ACES，加了后处理之后会**做两遍**、画面发暗。 */
  r.toneMapping = THREE.NoToneMapping;
  ST.renderer = r;

  ST.scene = new THREE.Scene();
  ST.scene.background = new THREE.Color(ST.cfg.bg);

  /* 🔴 **环境光（PMREM）** —— PBR 材质的立体感全靠它。
     没有它：只有平行光的直射高光，布料/金属/皮肤看着都是塑料。
     用 three 内置的 RoomEnvironment（一个"虚拟房间"的柔光），**不用下载 HDR 文件**。 */
  var pmrem = new THREE.PMREMGenerator(r);
  ST.envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  ST.scene.environment = ST.envRT.texture;
  ST.scene.environmentIntensity = 0.55;   // ⚠️ 别给满 —— 满了会盖掉三点光的方向感
  pmrem.dispose();

  ST.camera = new THREE.PerspectiveCamera(35, 3 / 4, 0.01, 200);
  ST.camera.position.set(0, 1, 3);

  ST.controls = new OrbitControls(ST.camera, r.domElement);
  ST.controls.enableDamping = true;
  ST.controls.dampingFactor = 0.08;
  ST.controls.target.set(0, 0.5, 0);
  // 同 pv3d 那条：dblclick 得挂 canvas，挂 controls 上是永远不触发的
  r.domElement.addEventListener('dblclick', function(){ stFrame(); });

  ST.holder = new THREE.Group();
  ST.scene.add(ST.holder);

  ST.clock = new THREE.Clock();
  stLights();

  /* 🔴 **后处理链**：渲染 → Bloom（发光）→ OutputPass（ACES 色调映射 + sRGB 转换）。
     为什么要它：现在 6.3 的"出图"就是裸渲染，`分步设计.md` 早就写了「调色 / Bloom / 暗角」，
     一直没实现 —— 这一步加上，成品图立刻不一样（亮部会有一层柔光，画面不再"干"）。
     ⚠️ 参数**别贪**：strength 0.32 / radius 0.7 / threshold 0.9 —— 再大就糊成一片。 */
  ST.composer = new EffectComposer(r);
  ST.composer.addPass(new RenderPass(ST.scene, ST.camera));
  ST.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.32, 0.7, 0.9);
  ST.composer.addPass(ST.bloom);
  ST.composer.addPass(new OutputPass());

  r.domElement.style.width = '100%';
  r.domElement.style.height = '100%';
  r.domElement.style.display = 'block';

  stLoop();
}

/* ---------- 灯光预设 ---------- */
function stClearLights(){
  ST.lights.forEach(function(l){ ST.scene.remove(l); });
  ST.lights = [];
}
function stAdd(l){ ST.scene.add(l); ST.lights.push(l); return l; }

function stLights(){
  stClearLights();
  var kind = ST.cfg.light;
  if (kind === 'soft'){
    stAdd(new THREE.HemisphereLight(0xffffff, 0x9a8f80, 2.6));
    var d = new THREE.DirectionalLight(0xffffff, 1.2);
    d.position.set(1.4, 2.4, 2.0);
    stAdd(d);
  } else if (kind === 'rim'){
    stAdd(new THREE.AmbientLight(0xffffff, 0.55));
    var back = new THREE.DirectionalLight(0xffd9b0, 3.0);
    back.position.set(-1.6, 1.6, -2.2);
    stAdd(back);
    var fill = new THREE.DirectionalLight(0xbdd4ff, 0.9);
    fill.position.set(1.8, 1.0, 1.4);
    stAdd(fill);
  } else {                                   // 三点光（默认）
    stAdd(new THREE.HemisphereLight(0xffffff, 0x9a8f80, 1.9));
    var key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1.6, 2.6, 2.2);
    stAdd(key);
    var fill2 = new THREE.DirectionalLight(0xffffff, 0.7);
    fill2.position.set(-2.2, 1.2, 1.0);
    stAdd(fill2);
    var rim2 = new THREE.DirectionalLight(0xffe6c8, 1.2);
    rim2.position.set(-0.8, 1.8, -2.4);
    stAdd(rim2);
  }
}

/* ---------- 材质预设 ---------- */
function stMaterials(){
  var kind = ST.cfg.material;
  ST.holder.traverse(function(o){
    if (!o.isMesh || !o.material) return;
    if (!o.userData.origMat) o.userData.origMat = o.material;   // 存一份原始的
    var src = o.userData.origMat;
    var list = Array.isArray(src) ? src : [src];

    if (kind === 'keep'){
      o.material = o.userData.origMat;
      return;
    }
    if (kind === 'toon'){
      o.material = new THREE.MeshToonMaterial({
        color: (list[0] && list[0].color) ? list[0].color.clone() : new THREE.Color(0xdddddd),
        map: (list[0] && list[0].map) || null
      });
    } else if (kind === 'flat'){
      o.material = new THREE.MeshBasicMaterial({
        color: (list[0] && list[0].color) ? list[0].color.clone() : new THREE.Color(0xbbbbbb),
        map: (list[0] && list[0].map) || null
      });
    } else if (kind === 'wire'){
      o.material = new THREE.MeshBasicMaterial({ color: 0x6b6259, wireframe: true });
    }
  });
}

/* ---------- 布料高亮：把某个高度区间的顶点染成橙色 ---------- */
function stClothPaint(){
  ST.holder.traverse(function(o){
    if (!o.isMesh || !o.geometry) return;
    var pos = o.geometry.attributes.position;
    if (!pos) return;
    if (!o.userData.origColors) o.userData.origColors = o.geometry.attributes.color
      ? o.geometry.attributes.color.array.slice() : null;

    var c = ST.cloth;
    if (!c || !o.userData.origColors){
      // 没有原始顶点色 → 造一份全白的，随时能染回去
      if (!o.geometry.attributes.color){
        var n = pos.count, arr = new Float32Array(n * 3);
        arr.fill(1);
        o.geometry.setAttribute('color', new THREE.BufferAttribute(arr, 3));
      } else if (!o.userData.origColors){
        o.userData.origColors = o.geometry.attributes.color.array.slice();
      }
    } else {
      o.geometry.attributes.color.array.set(o.userData.origColors);
    }

    var col = o.geometry.attributes.color;
    if (!col) return;

    // 模型高度归一化后，落在 [from, to] 区间里的顶点涂掉
    o.geometry.computeBoundingBox();
    var bb = o.geometry.boundingBox;
    var h = bb.max.y - bb.min.y || 1;
    for (var i = 0; i < pos.count; i++){
      if (!c){ col.setXYZ(i, 1, 1, 1); continue; }
      var y = (pos.getY(i) - bb.min.y) / h;
      if (y >= c.from && y <= c.to) col.setXYZ(i, 1.0, 0.45, 0.15);   // 橙色
    }
    col.needsUpdate = true;

    // 顶点色要材质认才行
    var m = o.material;
    if (m && !Array.isArray(m)){
      m.vertexColors = true;
      m.needsUpdate = true;
    }
  });
}

/* ---------- 加载模型 ---------- */
function stLoad(url, done){
  stInit();
  stClearHolder();
  ST.mixer = null; ST.played = false;
  new GLTFLoader().load(url, function(g){
    var obj = g.scene || g.scenes[0];
    ST.holder.add(obj);
    if (g.animations && g.animations.length){
      ST.mixer = new THREE.AnimationMixer(obj);
      /* 🔄 2026-10-06：4.3 改成「**一次出三段**」之后 `g.animations` 里是三段
         （`Loop_idle` / `Loop_run` / `Loop_walk`，glb 里按**字母序**排）——
         直接取 `[0]` 拿到的是**待机**。可 5.1 / 5.3 要看的是
         「**播动作看布料穿不穿模**」，待机幅度太小、裙子几乎不飘，**等于白看**。
         → **优先挑「走路」**（那才是会飘的那段），没有就退回第一段。
         ⚠️ 想要"哪段都能挑"，得在渲染台上也加一排动作按钮 ——
            现在先按"挑最像样的那段"处理。 */
      ST.anim = g.animations.filter(function(c){
        return /walk/i.test(c.name || '');
      })[0] || g.animations[0];
      var act = ST.mixer.clipAction(ST.anim);
      act.setLoop(THREE.LoopRepeat);
      act.play();
      act.paused = true;                 // 先停着，点「播」才动
      ST.action = act;
    }
    stMaterials();
    if (ST.cloth) stClothPaint();
    stFrame();
    if (done) done(true);
  }, undefined, function(){ if (done) done(false); });
}

function stClearHolder(){
  while (ST.holder.children.length){
    var c = ST.holder.children.pop();
    ST.holder.remove(c);
    c.traverse && c.traverse(function(o){
      if (o.geometry) o.geometry.dispose();
      if (o.material){
        (Array.isArray(o.material) ? o.material : [o.material]).forEach(function(m){
          Object.keys(m).forEach(function(k){ if (m[k] && m[k].isTexture) m[k].dispose(); });
          m.dispose();
        });
      }
    });
  }
}

function stFrame(){
  /* 🔴 包围盒用 `pv3dModelBox`（**会算上蒙皮**），别自己 traverse，也别用
     `setFromObject`。2026-10-06 阿聪报的「默认视角…**突然这么大**」就是这儿的坑：
     带骨架的模型（4.1 之后）用 `setFromObject` 会把 22 根 `Bone` 一起算进去，
     而骨骼跟网格节点**不是一个量纲**（网格节点常带 `scale:0.01` 做单位换算，
     骨骼的 translation 是米级）→ 盒子整个歪掉 → 相机糊在脸上。
     ⚠️ 当时的修法是"只算网格" —— 压住了症状，但**根因没动**：
     真正的问题是 `SkinnedMesh` 的 geometry 盒**本身就不对**（顶点存的是绑骨前的
     坐标，实际位置由骨骼决定）。详见 `pv3dModelBox` 上面的注释。 */
  var bb = pv3dModelBox(ST.holder);
  if (bb.isEmpty()) return;
  var size = bb.getSize(new THREE.Vector3());
  var center = bb.getCenter(new THREE.Vector3());
  var maxDim = Math.max(size.x, size.y, size.z) || 1;
  // 系数 2.1：1.75 是她整个撑满画面、上下都顶着边，看着太挤（截图看出来的）
  var dist = maxDim / (2 * Math.tan(Math.PI * ST.camera.fov / 360)) * 2.1;
  ST.camera.position.set(center.x, center.y + size.y * 0.05, center.z + dist);
  ST.camera.near = maxDim / 200;
  ST.camera.far = maxDim * 80;
  ST.camera.updateProjectionMatrix();
  ST.controls.target.copy(center);
  ST.controls.update();
}

function stResize(){
  if (!ST.renderer || !ST.host) return;
  var w = ST.host.clientWidth || 600, h = ST.host.clientHeight || 460;
  if (w < 10 || h < 10) return;      // 页面还没显示出来，量不到尺寸，等下次
  ST.renderer.setSize(w, h, false);
  if (ST.composer) ST.composer.setSize(w, h);   // 后处理链也要跟着尺寸走（不然 Bloom 会错位）
  ST.camera.aspect = w / h;
  ST.camera.updateProjectionMatrix();
}

function stLoop(){
  ST.raf = requestAnimationFrame(stLoop);
  var dt = ST.clock ? ST.clock.getDelta() : 0;
  if (ST.mixer) ST.mixer.update(dt);
  if (ST.controls) ST.controls.update();
  if (ST.renderer && ST.host && ST.host.clientHeight > 0){
    /* 有后处理链就走它（**别两个都调** —— 会渲染两遍，白费一半性能） */
    if (ST.composer) ST.composer.render(); else ST.renderer.render(ST.scene, ST.camera);
  }
}

/* ---------- 对外的接口 ---------- */
window.studioMount = function(hostId, url){
  stInit();
  var host = document.getElementById(hostId);
  if (!host) return false;
  if (ST.host !== host){
    host.appendChild(ST.renderer.domElement);   // 搬家（换父节点，context 不丢）
    ST.host = host;
    setTimeout(stResize, 30);
  }
  if (url && url !== ST.url){
    ST.url = url;
    stLoad(url, function(ok){ if (!ok) ST.url = ''; });
  }
  return true;
};

window.studioSet = function(key, val){
  stInit();          // 🔴 必须先起台子 —— stMaterials/stLights 都要用 ST.holder，
                     //    而「套设置」可能比 studioMount 先被调到（页面初始化那会儿），
                     //    不起就直接 traverse(null) 抛错，把后面全打断（踩过）
  ST.cfg[key] = val;
  if (key === 'light')   stLights();
  if (key === 'material') stMaterials();
  if (key === 'bg' && ST.scene) ST.scene.background = new THREE.Color(val);
  if (key === 'exposure' && ST.renderer) ST.renderer.toneMappingExposure = val;
};

window.studioCloth = function(from, to){
  ST.cloth = (from === null) ? null : { from: from, to: to };
  stInit();
  stClothPaint();
};

window.studioPlay = function(on){
  ST.played = !!on;
  if (ST.action) ST.action.paused = !on;
};

window.studioHasAnim = function(){ return !!ST.mixer; };

window.studioDebug = function(){
  var bb = ST.holder ? pv3dModelBox(ST.holder) : null;    // 跟 stFrame 同一把尺子
  return {
    cam: ST.camera ? ST.camera.position.toArray().map(function(v){return +v.toFixed(2);}) : null,
    target: ST.controls ? ST.controls.target.toArray().map(function(v){return +v.toFixed(2);}) : null,
    aspect: ST.camera ? +ST.camera.aspect.toFixed(2) : null,
    hostH: ST.host ? ST.host.clientHeight : 0,
    hostW: ST.host ? ST.host.clientWidth : 0,
    bb: bb && !bb.isEmpty() ? { min: bb.min.toArray().map(function(v){return +v.toFixed(2);}),
                               max: bb.max.toArray().map(function(v){return +v.toFixed(2);}) } : null
  };
};

window.studioInfo = function(){
  return { loaded: !!ST.holder && ST.holder.children.length > 0,
           hasAnim: !!ST.mixer, cfg: ST.cfg, cloth: ST.cloth,
           /* 播的是**哪一段**（2026-10-06 加）—— 4.3 一次出三段之后，
              "到底挑了哪段播"成了要验的东西（5.1/5.3 得播会飘的那段）。 */
           animName: ST.anim ? ST.anim.name : null };
};

/* 出图：把当前画面导成 PNG 的 dataURL。
   要更高的分辨率就临时把 renderer 调大、渲染一次、再调回来。 */
window.studioShot = function(size, cb){
  stInit();
  var w = size || 1024;
  var h = Math.round(w * 4 / 3);
  var oldW = ST.host ? ST.host.clientWidth : 0;
  var oldH = ST.host ? ST.host.clientHeight : 0;
  var oldAspect = ST.camera.aspect;
  var oldPR = ST.renderer.getPixelRatio();

  ST.renderer.setPixelRatio(1);
  ST.renderer.setSize(w, h, false);
  if (ST.composer) ST.composer.setSize(w, h);
  ST.camera.aspect = w / h;
  ST.camera.updateProjectionMatrix();
  /* 🔴 **出图必须也走 composer** —— 不然导出来的图**没有 Bloom**，
     跟屏幕上看到的**不是一个东西**（这处最容易漏：看着正常，图就是差一截）。 */
  if (ST.composer) ST.composer.render(); else ST.renderer.render(ST.scene, ST.camera);
  var data = ST.renderer.domElement.toDataURL('image/png');

  // 调回来
  ST.renderer.setPixelRatio(oldPR);
  ST.camera.aspect = oldAspect;
  ST.camera.updateProjectionMatrix();
  if (ST.host) {
    ST.renderer.setSize(oldW || 300, oldH || 400, false);
    if (ST.composer) ST.composer.setSize(oldW || 300, oldH || 400);
  }
  cb(data);
};

// 渲染台就绪 —— 回头把 5/6 站重画一遍（主脚本一开始画的时候还没有我们）
if (window.__studioReady) window.__studioReady();

// 复位：把相机拉回「整个模型刚好塞满画面」的那个默认视角
/* 「显示布线」开关 */
var pv3dWireBtn = document.getElementById('pv3dWire');
if (pv3dWireBtn) pv3dWireBtn.addEventListener('click', function(){
  wireOn = !wireOn;
  this.classList.toggle('did', wireOn);
  pv3dApplyWire();
});

/* 🆕 「白模」开关（见上面的 `pv3dSetWhite`） */
var pv3dWhiteBtn = document.getElementById('pv3dWhite');
if (pv3dWhiteBtn) pv3dWhiteBtn.addEventListener('click', function(){
  whiteOn = !whiteOn;
  this.classList.toggle('did', whiteOn);
  /* 开白模 → 先把抢同一批材质槽的那两个收掉。
     🔴 **白模必须"最后才应用"**（见 `pv3dSetWhite` 上头那段：反过来的话
        `pv3dSetBakeMaps` 会把"被摘过的样子"存成快照）。 */
  if (whiteOn){
    if (uvCheckOn){
      uvCheckOn = false;
      var _uw = document.getElementById('pv3dUV');
      if (_uw) _uw.classList.remove('did');
      pv3dApplyUVCheck();
    }
    /* 🔴 2026-10-15：**锁死的 step（2.2）不许收 `bakeView`** —— 阿聪 报的那个 bug 就是这行干的：
       点一次白模再点掉，"关掉法线"的**高亮和效果一起没了**（高亮按 `bakeView` 画、
       材质也按它铺）。锁死时它是固定的，收了也回不来。
       ⚠️ 别的一步照旧收（避免白模和法线两个抢同一批材质槽）。 */
    if (bakeView && !bakeLockedNow){
      bakeView = '';
      pv3dMarkBakeBtns();
      pv3dApplyBakeMaps();
    }
  }
  pv3dApplyWhite();
  /* 🆕 2026-10-15：**关白模之后，把固定的「关掉法线」重新压上** ——
     `pv3dApplyWhite` 还原时会把 `normalMap` 还回原值（它那份快照存的是"开白模那一刻"），
     正好把"关掉法线"冲掉 —— 这是那个 bug 的另一半。
     ⚠️ **只在白模关着时压**：开着时压会把它摘掉的贴图还回去、白模就失效了
        （原代码"开白模前先收 bakeView"正是避这个）。 */
  if (!whiteOn && bakeLockedNow){
    pv3dMarkBakeBtns();          // 高亮恢复（锁死时 `bakeView` 全程没被清过，还是 n-off）
    pv3dApplyBakeMaps();
  }
});

/* 🆕 「显示原点」开关（见上面的 `pv3dApplyOrigin`）——
   ⚠️ 它**不抢材质槽**，跟白模 / UV / 法线互不干扰，所以不用像它们那样"排队收谁"，
      点了直接重画就行。 */
var pv3dOriginBtn = document.getElementById('pv3dOrigin');
if (pv3dOriginBtn) pv3dOriginBtn.addEventListener('click', function(){
  originOn = !originOn;
  this.classList.toggle('did', originOn);
  pv3dApplyOrigin();
});

/* 🆕「显示面朝向」（见上面的 `pv3dApplyFacing`）—— 跟「显示原点」一个套路。
   ⚠️ 它**不抢材质槽**（改的是 `side` + shader），所以不用像白模 / UV / 法线那样"排队收谁"。 */
var pv3dFacingBtn = document.getElementById('pv3dFacing');
if (pv3dFacingBtn) pv3dFacingBtn.addEventListener('click', function(){
  facingOn = !facingOn;
  this.classList.toggle('did', facingOn);
  pv3dApplyFacing();
});

/* 🆕「平面着色」（见上面的 `pv3dApplyFlat`）—— **默认开，但点得掉**（阿聪 说"默认"不是"锁死"）。
   ⚠️ 它同样不抢材质槽（改的是 `flatShading` 属性），不用像白模 / UV / 法线那样排队收谁。 */
var pv3dFlatBtn = document.getElementById('pv3dFlat');
if (pv3dFlatBtn) pv3dFlatBtn.addEventListener('click', function(){
  flatOn = !flatOn;
  this.classList.toggle('did', flatOn);
  pv3dApplyFlat();
});

/* 🆕「自动平滑」（见上面的 `pv3dApplyAutoSmooth`）—— **默认开，但点得掉**（点掉 = 回全平滑）。 */
var pv3dSmoothBtn = document.getElementById('pv3dSmooth');
if (pv3dSmoothBtn) pv3dSmoothBtn.addEventListener('click', function(){
  autoSmoothOn = !autoSmoothOn;
  this.classList.toggle('did', autoSmoothOn);
  pv3dApplyAutoSmooth();
});

/* 🆕 2026-10-15「调试」下拉：点面板**外面**就收起来 ——
   原生 details 只认 summary 那一下，点别的哪儿都不收，
   不收的话展开的面板会一直挂在画布右上角（挡视线）。
   ⚠️ 点**面板里**不动（`contains` 那一句）—— 这样他能连着点下一项。
   ⚠️ 这个监听挂 `document`、只在模块加载时加一次（glbview 是单例，见上面 pv3dEnsurePanel）。 */
var pv3dDbgEl = document.getElementById('pv3dDbg');
if (pv3dDbgEl) document.addEventListener('click', function(e){
  if (!pv3dDbgEl.open) return;
  if (pv3dDbgEl.contains(e.target)) return;
  pv3dDbgEl.open = false;
});

/* 「UV 检查」开关 —— 换上彩色的 UV 检查色块（见上面的 pv3dApplyUVCheck） */
var pv3dUVBtn = document.getElementById('pv3dUV');
if (pv3dUVBtn) pv3dUVBtn.addEventListener('click', function(){
  uvCheckOn = !uvCheckOn;
  this.classList.toggle('did', uvCheckOn);
  /* 🔴 **白模排在最前收** —— 顺序有讲究，见 `pv3dSetWhite` 上头那段。 */
  if (uvCheckOn && whiteOn){
    whiteOn = false;
    var _wu = document.getElementById('pv3dWhite');
    if (_wu) _wu.classList.remove('did');
    pv3dApplyWhite();
  }
  /* 反过来也一样：开 UV 检查时把「纯贴图」收掉（它俩抢同一个位置，见上面那段） */
  if (uvCheckOn && bakeView.indexOf('-raw') > 0){
    bakeView = '';
    pv3dMarkBakeBtns();
    pv3dApplyBakeMaps();
  }
  pv3dApplyUVCheck();
});

/* 「纯法线」（左栏）／「关掉法线」（调试下拉）—— **两个独立按钮**（2026-10-15 拆开的）。
   原来是一张**两格卡**并排，阿聪 后来定了：「关掉法线放进调试里，纯法线继续留左栏」。
   🔑 **语义没变**：还是"一次最多亮一个、再点亮着那个 = 回模型原样"：
     ''      = 两个都不亮 = **模型原样**（法线生效）
     'n-raw' = 纯法线（把贴图本身铺上去看）
     'n-off' = 关掉法线（看没加它的裸模型）
   ⚠️ `mode` 就是 `bakeView` 里存的那个值。 */
function pv3dBindBakeOne(id, mode){
  var b = document.getElementById(id);
  if (!b) return;
  b.addEventListener('click', function(){
    bakeView = (bakeView === mode) ? '' : mode;   // 再点**已经亮着的那个** = 回"模型原样"
    /* 🔴 **先收白模**（顺序有讲究，见 `pv3dSetWhite` 上头那段） */
    if (bakeView && whiteOn){
      whiteOn = false;
      var wb = document.getElementById('pv3dWhite');
      if (wb) wb.classList.remove('did');
      pv3dApplyWhite();
    }
    /* ⚠️ 「纯法线」跟「UV 检查」抢同一个位置（都在改 `mat.map` / 光照）——
       开纯法线就把 UV 检查收掉，不然两个都在写，谁后点谁赢，看着像坏了。
       （「关掉法线」不动 `map` / 光照，所以不用收 UV 检查。） */
    if (bakeView === 'n-raw' && uvCheckOn){
      uvCheckOn = false;
      var ub = document.getElementById('pv3dUV');
      if (ub) ub.classList.remove('did');
      pv3dApplyUVCheck();
    }
    pv3dMarkBakeBtns();
    pv3dApplyBakeMaps();
  });
}
pv3dBindBakeOne('pv3dNormalRaw', 'n-raw');
pv3dBindBakeOne('pv3dNormalOff', 'n-off');

/* 「显示骨架 / 显示骨名」那张卡 —— **跟法线那张一个形态**：
   两格 + 一个"都不亮"，一次只看一个，再点已经亮着的那格 = 回"不画"。
   ⚠️ 顺序跟界面一致：布线 → UV → 法线 → **骨架** → 动画（= 能力解锁的先后）。
   ⚠️ 没骨头的模型上这张卡是 `disabled` 的，浏览器**不会派发 click**。 */
function pv3dMarkSkelBtns(){
  var b = document.getElementById('pv3dSkel');
  if (!b) return;
  Array.prototype.forEach.call(b.querySelectorAll('.pv3d-half'), function(h){
    h.classList.toggle('on', h.getAttribute('data-m') === skelView);
  });
}
var pv3dSkelBtn = document.getElementById('pv3dSkel');
if (pv3dSkelBtn) pv3dSkelBtn.addEventListener('click', function(e){
  var h = (e.target && e.target.closest) ? e.target.closest('.pv3d-half') : null;
  if (!h || !this.contains(h)) return;
  var next = h.getAttribute('data-m');                 // 'bone' / 'name'
  skelView = (skelView === next) ? '' : next;          // 再点亮着的那格 = 回"不画"
  pv3dMarkSkelBtns();
  pv3dApplySkeleton();
});

/* 「播放动画」开关 —— 见 `pv3dAnim` 那个按钮上面的注释。
   ⚠️ 靠 `timeScale` 播/停（不重置进度）；没动作的模型上按钮是 `disabled` 的，
      浏览器不会派发 click，所以这儿不用再判一次。 */
var pv3dAnimBtn = document.getElementById('pv3dAnim');
/* 「姿态模式」总开关 —— 点一下进、再点一下出（出 = 姿势还原）。 */
var pv3dPoseBtn = document.getElementById('pv3dPose');
if (pv3dPoseBtn) pv3dPoseBtn.addEventListener('click', function(){
  pv3dSetPose();                                // 不传 = 切换
});

/* 🎞 **「动画模式」总开关** —— 点一下进、再点一下出（跟姿态模式一个手感）。
   ⚠️ **退出时顺手停播** —— 跟"退出姿态模式会还原姿势"是一个道理：
      不然控件收起来了、动画还在后台空转，用户想停都没地方点。 */
var pv3dAnimModeBtn = document.getElementById('pv3dAnimMode');
if (pv3dAnimModeBtn) pv3dAnimModeBtn.addEventListener('click', function(){
  animModeOn = !animModeOn;
  if (!animModeOn && pv3dAnimOn && pv3dMixer){
    pv3dAnimOn = false;
    pv3dMixer.timeScale = 0;
    var _b = document.getElementById('pv3dAnim');
    if (_b){ _b.classList.remove('on'); _b.innerHTML = '&#9654; 播放'; }
  }
  pv3dSyncPoseUI();
});

/* 🎨 「权重图」—— 挑一根骨，模型按它的权重着色（看蒙皮质量最直接的一把尺子）。
   ⚠️ 它在**姿态模式那排浮层里**（阿聪：「在操作和骨骼中间插一个」）→
      只有姿态模式开着才点得到，所以不用管"还没填骨名列表"那种情况。 */
var pv3dWeightBtn = document.getElementById('pv3dWeight');
if (pv3dWeightBtn) pv3dWeightBtn.addEventListener('click', function(){
  weightOn = !weightOn;
  if (weightOn) pv3dApplyWeightMap();
  else pv3dClearWeightMap();
  pv3dSyncPoseUI();                            // 按钮亮暗 + 提示都在这儿刷
  var tip = document.getElementById('pv3dTip');
  if (tip) tip.textContent = weightOn
    ? (poseBone
        ? '正在看「' + (poseBone.name || '?') + '」的影响范围：红=吃满、蓝=没吃到 ｜ '
          + '换一根：画布上点，或左上角列表里选'
        : '点一根骨（画布上点，或左上角列表里选）→ 看它影响哪儿：红=吃满、蓝=没吃到')
    : (poseOn ? '点一根骨 → 拖它｜W 移动 / E 旋转 / R 复位｜再点「姿态模式」= 退出'
              : '拖动旋转 · 滚轮缩放 · 双击画面也能复位');
});

/* 画布右上角那两个工具按钮（旋转 / 移动）—— 只在姿态模式下露出。
   ⚠️ 用 `pointerdown` 而不是 `click`：它比 OrbitControls 的监听更早，
      点了不会顺带把相机也转一下（那两个按钮盖在画布上）。 */
var pv3dPosectl = document.getElementById('pv3dPosectl');
if (pv3dPosectl){
  pv3dPosectl.addEventListener('pointerdown', function(ev){
    var b = (ev.target && ev.target.closest) ? ev.target.closest('.pv3d-posebtn') : null;
    if (!b) return;
    ev.stopPropagation();                       // 别让相机跟着动
  }, true);
  pv3dPosectl.addEventListener('click', function(ev){
    var b = (ev.target && ev.target.closest) ? ev.target.closest('.pv3d-posebtn') : null;
    if (!b) return;
    ev.stopPropagation();
    var t = b.getAttribute('data-tool');
    if (t === 'reset') pv3dPoseResetPose();     // 「复位姿势」是**动作**，不是切工具
    else pv3dSetPoseTool(t);
  });
}

if (pv3dAnimBtn) pv3dAnimBtn.addEventListener('click', function(){
  if (!pv3dMixer) return;
  /* 点播放 = 让动画接管骨架（打开时 `pv3dRestMode` 是 true，跳过 mixer） */
  pv3dRestMode = false;
  pv3dAnimOn = !pv3dAnimOn;
  pv3dMixer.timeScale = pv3dAnimOn ? pv3dAnimSpeed : 0;   // 速度由旁边的挡位管
  this.classList.toggle('on', pv3dAnimOn);                // 亮 = 正在播
  this.innerHTML = pv3dAnimOn ? '&#10074;&#10074; 暂停' : '&#9654; 播放';
});

/* 「播放速度」——左上角那排里的三个挡位（0.5× / 1× / 2×）。
   ⚠️ 换挡**不重置进度**（`timeScale` 是倍率，不是一个位置）——
      0.5× 切 2× 是"接着那儿快放"，不是"从头来"。
   ⚠️ 停着的时候换挡也照记（`pv3dAnimSpeed` 存着），下次点播放就用新速度。 */
var pv3dAnimCtl = document.getElementById('pv3dAnimctl');
if (pv3dAnimCtl){
  pv3dAnimCtl.addEventListener('click', function(ev){
    var t = ev.target;
    if (!t || !t.closest) return;

    /* 🎞 **动作切换**（待机 / 走路 / 跑步）—— 模型有几段就有几个按钮。
       ⚠️ 换动作**从头开始**（跟换挡不一样）—— 换了一段却接着上一段的时间轴，
          看着就像"跳帧"。 */
    var a = t.closest('.pv3d-act');
    if (a){
      var i = parseInt(a.getAttribute('data-i'), 10) || 0;
      if (!pv3dMixer || !pv3dClips[i]) return;
      pv3dMixer.stopAllAction();
      pv3dMixer.clipAction(pv3dClips[i]).play();
      pv3dClipIdx = i;
      pv3dMixer.timeScale = pv3dAnimOn ? pv3dAnimSpeed : 0;
      Array.prototype.forEach.call(this.querySelectorAll('.pv3d-act'), function(x){
        x.classList.toggle('on', x === a);
      });
      return;
    }

    /* 播放速度（0.5× / 1× / 2×）—— 见上面那段说明 */
    var b = t.closest('.pv3d-spd');
    if (!b) return;
    pv3dAnimSpeed = parseFloat(b.getAttribute('data-s')) || 1;
    Array.prototype.forEach.call(this.querySelectorAll('.pv3d-spd'), function(x){
      x.classList.toggle('on', x === b);
    });
    if (pv3dMixer && pv3dAnimOn) pv3dMixer.timeScale = pv3dAnimSpeed;
  });
}



document.getElementById('pv3dFit').addEventListener('click', function(){
  var btn = this;
  if (typeof holder !== 'undefined' && holder) frame(holder);
  /* 点完给个明确反馈：按钮闪一下。
     ⚠️ 为什么要这个：模型本来就是默认视角时，点复位**画面上什么都不会变**，
        看着就跟"没反应"一样（阿聪 2026-10-03：「复位还是用不了」就是这么来的）。
        按钮闪一下，至少能确认"它响应了"。 */
  btn.classList.add('did');
  var t = btn.textContent;
  btn.textContent = '✓ 已复位';
  setTimeout(function(){ btn.classList.remove('did'); btn.textContent = t; }, 700);
});
/* 点关节球 → 选中那根骨（gizmo 就跟上去了）。
   🔴 两点讲究：
     ① 只在**开着「拖骨骼」**时才吃这个事件 —— 平时点画面是"转视角"，别抢。
     ② 用 **capture 阶段**（第三参数 `true`）+ `stopPropagation` 把 OrbitControls
        挡掉 —— 不然点上去的同一瞬间相机也开始转了（两个都监听 pointerdown，
        OrbitControls 还不知道你想选骨头）。 */
/* ⚠️ 绑在**弹层根元素**上，**不是 `renderer.domElement`** ——
   模块顶层这几行是**加载时就跑**的，而 `renderer` 要等第一次打开弹层才建，
   那会儿它还是 `undefined` → `undefined.domElement` 直接抛错，
   整个绑定的后半段（下面几行）也一起没了。
   （2026-10-06 踩的：报错指向页面行号，看着像别处坏了。）
   绑在 `pv3d` 上还有个好处：它是 canvas 的**祖先**，capture 阶段照样比
   OrbitControls 先收到。 */
pv3d.addEventListener('pointerdown', function(ev){
  if (!poseOn) return;
  if (pv3dPosePick(ev)) ev.stopPropagation();
}, true);

document.getElementById('pv3dClose').addEventListener('click', function(){ window.pv3dClose(); });
pv3d.addEventListener('click', function(e){ if (e.target === pv3d) window.pv3dClose(); });
document.addEventListener('keydown', function(e){
  if (pv3d.hidden) return;
  if (e.key === 'Escape'){ window.pv3dClose(); return; }
  /* 姿态模式的快捷键 —— **跟 UE 视口同款**（阿聪 2026-10-06：「然后**附上快捷键**，
     可以直接用 **ue 的同款快捷键**」）：W = 移动、E = 旋转。
     ⚠️ **只在姿态模式开着**时才吃这两个键 —— 否则她在别的地方按 W/E
        会莫名其妙把工具切了。 */
  if (!poseOn) return;
  var k = (e.key || '').toLowerCase();
  if (k === 'w'){ e.preventDefault(); pv3dSetPoseTool('move'); }
  else if (k === 'e'){ e.preventDefault(); pv3dSetPoseTool('rotate'); }
  /* R = 复位姿势（阿聪 2026-10-06：「复位姿势可以给个 **R 键**」）——
     ⚠️ 跟 Blender 的 `Alt+R`（清旋转）是一个心思，但这儿 R 还空着（我们没有缩放）。 */
  else if (k === 'r'){ e.preventDefault(); pv3dPoseResetPose(); }
});
