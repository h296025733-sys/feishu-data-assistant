import { inspectTable } from "../importer/inspect.js";
import { LocalFileDataSource } from "../importer/local-file.js";

try {
  const table = await new LocalFileDataSource().getTable();
  console.log(JSON.stringify(inspectTable(table), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
