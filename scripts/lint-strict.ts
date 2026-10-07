import { ESLint } from "eslint";

// The API reports all findings; legacy suppression is applied only by the CLI.
const eslint = new ESLint();
const results = await eslint.lintFiles(
  process.argv.length > 2 ? process.argv.slice(2) : ["."],
);
const formatter = await eslint.loadFormatter("stylish");
const output = formatter.format(results);
if (output) console.log(output);
if (results.some((result) => result.errorCount || result.warningCount))
  process.exitCode = 1;
