import { getEnv } from "../config/env.js";
import { NaturalWriteIntentResolver } from "../realtime/natural-write-intent.js";

const text = process.argv[2]?.trim();
if (!text) throw new Error("请提供要检查的自然语言写入指令");
const now = process.argv[3] ? new Date(process.argv[3]) : new Date();
if (Number.isNaN(now.getTime())) throw new Error("检查时间无效");
const intent = await new NaturalWriteIntentResolver(getEnv()).resolve(text, now);
process.stdout.write(`${JSON.stringify(intent, null, 2)}\n`);
