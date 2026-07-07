import path from "node:path"
import { mkdirSync } from "node:fs"

/**
 * 数据目录：所有运行时配置 / 缓存 / 生成文件的存放位置。
 * - 默认当前工作目录（向后兼容，旧部署无需改动）
 * - 通过环境变量 mdataDir / DATA_DIR 指向挂载卷，可让容器重建（升级镜像）后配置不丢失
 *
 * 注意：只能用环境变量指定——system-config.json 等配置本身就在该目录内，
 * 无法从配置文件里读取此路径（鸡生蛋问题）。
 */
const DATA_DIR = process.env.mdataDir || process.env.DATA_DIR || process.cwd()

// 确保数据目录存在（首次挂载空卷时）
try {
  mkdirSync(DATA_DIR, { recursive: true })
} catch (error) {
  // 已存在或无法创建；无法创建时后续读写会自然报错
}

/**
 * 拼接数据目录下的文件路径
 * @param {string} name - 文件名（如 'system-config.json'）
 * @returns {string}
 */
function dataPath(name) {
  return path.join(DATA_DIR, name)
}

export { DATA_DIR, dataPath }
