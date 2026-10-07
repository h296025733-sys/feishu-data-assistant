import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const source = path.join(root, "dist");
const target = path.join(root, "dist-test");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
await writeFile(path.join(target, "project.config.json"), JSON.stringify({
  appid: "demo_7ee89be4",
  projectname: `store-operations-workbench-test-${packageJson.version}`,
  blocks: ["index"],
}), "utf8");
await writeFile(path.join(target, "index.json"), JSON.stringify({
  blockTypeID: "demo_611ddfc6",
  blockRenderType: "offlineWeb",
}), "utf8");

console.log(`测试企业上传包已生成：${target}`);
