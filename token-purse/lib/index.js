/**
 * TokenPurse（鲸囊）· 主机半边。
 *
 * 这是一个「双面」DSH 插件：浏览器半边由 package.json 的 dsh.client 声明 +
 * exports["./client"] 提供给 Web 客户端；这里的主机半边只提供一个 Loader 行，
 * 让 dsh-client-modules 能把本包扫描进 window.__DSH_BOOT__ 的浏览器清单。
 *
 * 花费换算全部在浏览器端完成，因此主机半边不需要任何服务或状态。
 */
export function apply() {}