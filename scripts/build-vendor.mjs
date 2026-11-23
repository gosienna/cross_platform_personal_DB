// One-time bundle of the two third-party libraries into extension/vendor/ (plain scripts, no build step elsewhere).
//   vendor/anthropic.js → globalThis.Anthropic   (official @anthropic-ai/sdk, used only by AI extract)
//   vendor/xlsx.js      → globalThis.XLSX        (SheetJS, for .xlsx import)
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
mkdirSync('extension/vendor', { recursive: true });
const common = { bundle: true, format: 'iife', platform: 'browser', target: 'chrome116', minify: true, legalComments: 'eof', logLevel: 'info' };
await build({ ...common, stdin: { contents: "import Anthropic from '@anthropic-ai/sdk'; globalThis.Anthropic = Anthropic;", resolveDir: '.' }, outfile: 'extension/vendor/anthropic.js' });
await build({ ...common, stdin: { contents: "import * as XLSX from 'xlsx'; globalThis.XLSX = XLSX;", resolveDir: '.' }, outfile: 'extension/vendor/xlsx.js' });
