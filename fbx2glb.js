/* FBX → GLB（在浏览器里转，不经过服务器）
 *
 * 两条路，**优先用 Assimp**：
 *   ① assimpjs（Assimp 编译成 wasm）—— 它能正确重建 FBX 的 BindPose / 继承模式，
 *      美术导出的 FBX（Max/Maya 那种带 Lcl Scaling、InheritType 的）用它转出来
 *      骨架和网格是对得上的。
 *   ② three 的 FBXLoader —— 兜底。它**不读 BindPose**，某些文件转出来
 *      「网格对、骨架错位」（实测 CP_ZhangXiaoling：骨架只到 60，网格 157）。
 *      所以只有当 Assimp 失败时才用它，并且界面会提示"骨架可能不准"。
 *
 * 对外只有一个函数：window.fbxToGlb(file) → Promise<File（.glb）>
 * 另外把这次用的是哪条路写进 window.fbxToGlb.方式，页面拿它显示提示。
 */
import { FBXLoader } from './fbx/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

function 新名字(file, 扩展) {
  return file.name.replace(/\.[^.]+$/, '') + 扩展;
}

/* ① Assimp 那条路 */
async function 用Assimp(file) {
  if (typeof window.assimpjs !== 'function') {
    throw new Error('assimpjs 没加载');
  }
  const 库 = await window.assimpjs();
  const 清单 = new 库.FileList();
  清单.AddFile(file.name, new Uint8Array(await file.arrayBuffer()));
  const 结果 = 库.ConvertFileList(清单, 'glb2');   // glb2 = 贴图内嵌，单文件
  if (!结果.IsSuccess() || 结果.FileCount() === 0) {
    throw new Error('Assimp 转不了：' + 结果.GetErrorCode());
  }
  const 字节 = 结果.GetFile(0).GetContent();
  return new File([字节], 新名字(file, '.glb'), { type: 'model/gltf-binary' });
}

/* ② three 的 FBXLoader（兜底） */
function 用FBXLoader(file, 进度) {
  return new Promise(function (成功, 失败) {
    var 源地址 = URL.createObjectURL(file);
    new FBXLoader().load(源地址, function (物体) {
      URL.revokeObjectURL(源地址);
      try {
        new GLTFExporter().parse(物体, function (结果) {
          成功(new File([结果], 新名字(file, '.glb'), { type: 'model/gltf-binary' }));
        }, 失败, {
          binary: true,
          animations: 物体.animations || [],
          onlyVisible: true,
        });
      } catch (e) {
        失败(e);
      }
    }, 进度, function (e) {
      URL.revokeObjectURL(源地址);
      失败(e);
    });
  });
}

/* 转换方式：'auto'（Assimp 优先）/ 'assimp' / 'three'
   —— 两种转换器各有毛病，界面上让使用者自己选：
      · assimp：骨架位置准，但可能丢材质（贴图是外部文件时）和小部件位置
      · three ：材质准，但不读 BindPose，某些美术导出的 FBX 骨架会错位 */
window.fbxToGlb = async function (file, 进度) {
  const 偏好 = window.__fbx偏好 || window.fbxToGlb.偏好 || 'auto';
  if (偏好 !== 'three') {
    try {
      const glb = await 用Assimp(file);
      window.fbxToGlb.方式 = 'assimp';
      return glb;
    } catch (e) {
      console.warn('[fbx2glb] Assimp 没用上，退回 three 的 FBXLoader：', e);
      if (偏好 === 'assimp') throw e;
    }
  }
  const glb = await 用FBXLoader(file, 进度);
  window.fbxToGlb.方式 = 'three';
  return glb;
};
window.fbxToGlb.偏好 = 'auto';
window.fbxToGlb.方式 = '';

window.fbxReady = true;
