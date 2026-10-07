import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { validateDownloadedVideo } from "../video-analysis/media-validation.js";

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`${name} required`);
  return process.argv[index + 1];
}
const videoId = flag("--video-id");
const source = path.resolve(flag("--source"));
const infoPath = path.resolve(flag("--info"));
const root = path.resolve(".runtime");
for (const file of [source, infoPath]) {
  if (!file.startsWith(root + path.sep) || !existsSync(file)) throw new Error("Existing project-local runtime evidence required");
}
const probe = JSON.parse(execFileSync("D:/workspace/seedance-tiktok-director/.runtime/ffmpeg/bin/ffprobe.exe",
  ["-v", "error", "-show_streams", "-show_format", "-of", "json", source], { encoding: "utf8", timeout: 30_000 }));
const info = JSON.parse(readFileSync(infoPath, "utf8"));
const validationError = validateDownloadedVideo(probe, videoId, info);
const receipt = { at: new Date().toISOString(), scope: "local identity/video-track/duration verification; no AI or business-table write",
  videoId, source, infoPath, validationError, sha256: createHash("sha256").update(readFileSync(source)).digest("hex"),
  duration: Number(probe.format.duration), bytes: Number(probe.format.size),
  videoStreams: probe.streams.filter((stream: any) => stream.codec_type === "video")
    .map((stream: any) => ({ codec: stream.codec_name, width: stream.width, height: stream.height })),
  downloadVersion: info._version?.version };
writeFileSync(source + ".validation.json", JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt, null, 2));
if (validationError) process.exitCode = 1;
