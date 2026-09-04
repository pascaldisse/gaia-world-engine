#!/usr/bin/env bun
import path from 'node:path';
import { scanGuids, writeJSON } from './pipeline.mjs';
const args=process.argv.slice(2), project=args.shift();
if(!project || project.startsWith('-'))throw new Error('usage: scan.mjs <Unity project> --out <guids.json> [--package-root <dir>]');
let out;const packageRoots=[];
for(let i=0;i<args.length;i++) {
 if(args[i]==='--out')out=args[++i];
 else if(args[i]==='--package-root')packageRoots.push(args[++i]);
 else throw new Error(`unknown scan option: ${args[i]}`);
}
if(!out)throw new Error('--out required');
const result=scanGuids(path.resolve(project),{packageRoots});writeJSON(path.resolve(out),result);
console.log(JSON.stringify({out,guidCount:result.guidCount,metaCount:result.metaCount,conflicts:result.conflicts.length,missingAssets:result.missingAssets.length}));
if(result.conflicts.length)process.exitCode=1;
