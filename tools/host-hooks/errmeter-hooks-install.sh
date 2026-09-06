#!/usr/bin/env bash
# Owner-run installer. All mutation lives behind --apply.
set -u
command -v node >/dev/null 2>&1 || { echo 'Cannot continue: Node 18 or newer is required.' >&2; exit 3; }
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd) || exit 3
# shellcheck disable=SC2016
node -e '
const fs = require("node:fs"), path = require("node:path"), cp = require("node:child_process");
const root = process.argv[1], args = process.argv.slice(2), rawHome = process.env.HOME;
if(!rawHome || !path.isAbsolute(rawHome) || path.resolve(rawHome)===path.parse(rawHome).root) { console.error("Cannot continue: HOME must be an absolute non-root directory"); process.exit(3); }
const home=path.resolve(rawHome);
const fail = message => { throw new Error(message); };
let mode = "install", apply = false, from, targets = [];
for (let i=0;i<args.length;i++) {
  const a=args[i];
  if (a === "--help") { console.log("Usage: errmeter-hooks-install.sh (--sitter|--claude-code|--codex|--all) [--apply]\nDry-run is the default. Only named targets are edited. Backups: ~/.errmeter/backups/<timestamp>/.\nNever edits the fma repository; apply its documented patch separately.\nRestore: errmeter-hooks-restore.sh [--from <timestamp>]\nStatus: errmeter-hooks-status.sh"); process.exit(0); }
  if (a === "--mode" && ["status","restore"].includes(args[i+1])) mode=args[++i];
  else if (a === "--apply") apply=true;
  else if (a === "--from" && args[i+1]) from=args[++i];
  else if (["--sitter","--claude-code","--codex"].includes(a)) targets.push(a.slice(2));
  else if (a === "--all") targets.push("sitter","claude-code","codex");
  else { console.error("Usage error: unknown or incomplete option"); process.exit(2); }
}
targets=[...new Set(targets)];
if ((mode === "install" && (!targets.length || from)) || (mode !== "install" && (targets.length || apply)) || (mode !== "restore" && from)) { console.error("Usage error: select installation targets, or use restore/status options."); process.exit(2); }
const rels={sitter:[".claude/scripts/sitter-on-fail.sh"], "claude-code":[".claude/settings.json",".errmeter/hooks/claude-code-emit.sh"], codex:[".codex/config.toml",".errmeter/hooks/codex-notify-emit.sh"]};
const allowed=new Set(Object.values(rels).flat());
const backupRoot=path.join(home,".errmeter/backups");
function stat(p) {try{return fs.lstatSync(p);}catch(e){if(e.code==="ENOENT")return null;throw e;}}
function safe(rel) {
  if (!allowed.has(rel)) fail("Unrecognized backup destination");
  const p=path.join(home,rel);
  let q=p;
  for(let depth=0;depth<128;depth++) {if(stat(q)?.isSymbolicLink())fail("Refusing symlink destination: "+rel);if(q===home)return p;const parent=path.dirname(q);if(parent===q)break;q=parent;}
  fail("Destination traversal exceeded HOME boundary");
}
function bytes(rel,required=false) {const p=safe(rel),s=stat(p);if(!s){if(required)fail("Missing file: "+rel);return null;}if(!s.isFile())fail("Not a regular file: "+rel);return fs.readFileSync(p);}
function read(rel,required=false) {const b=bytes(rel,required);if(b===null)return null;const text=b.toString("utf8");if(!Buffer.from(text,"utf8").equals(b))fail("Invalid UTF-8: "+rel);return text;}
function manifests() {
  if(!fs.existsSync(backupRoot)) return [];
  if(fs.lstatSync(backupRoot).isSymbolicLink()) fail("Refusing symlink backup directory");
  return fs.readdirSync(backupRoot).filter(n=>/^[0-9TZ.-]+$/.test(n)).sort().reverse().flatMap(n=> {
    const p=path.join(backupRoot,n,"manifest.json");
    if(!fs.existsSync(p)) return [];
    const m=JSON.parse(fs.readFileSync(p,"utf8")); return [{...m,id:n}];
  });
}
// Locate object/array end offsets without reserializing any original JSON bytes.
function spans(text) {
  JSON.parse(text); const result=new Map(); let i=0;
  const ws=()=>{while(/\s/.test(text[i]||"") && i<text.length)i++;};
  const str=()=>{const start=i++;while(i<text.length){if(text[i++]==="\\")i++;else if(text[i-1]===String.fromCharCode(34))break;}return JSON.parse(text.slice(start,i));};
  function value(keys) { ws();const start=i, c=text[i];
    if(c==="{") {i++;ws();const seen=new Set();while(text[i]!=="}"){const k=str();if(seen.has(k))fail("Duplicate JSON key");seen.add(k);ws();i++;value(keys.concat(k));ws();if(text[i]!==",")break;i++;ws();}i++;}
    else if(c==="["){i++;ws();let n=0;while(text[i]!=="]"){value(keys.concat(String(n++)));ws();if(text[i]!==",")break;i++;}i++;}
    else if(c===String.fromCharCode(34))str();else {while(i<text.length&&!/[\s,}\]]/.test(text[i]))i++;}
    result.set(JSON.stringify(keys),{start,end:i});
  } value([]);return result;
}
function jsonHook(text,event,entry) {
  const obj=JSON.parse(text);if(!obj||Array.isArray(obj)||typeof obj!=="object")fail("Settings must be a JSON object");
  const locations=spans(text); let keys=[],addition;
  if(!Object.hasOwn(obj,"hooks")) addition="\"hooks\":"+JSON.stringify({[event]:[entry]});
  else {if(!obj.hooks||Array.isArray(obj.hooks)||typeof obj.hooks!=="object")fail("Invalid hooks object");keys=["hooks"];
    if(!Object.hasOwn(obj.hooks,event))addition=JSON.stringify(event)+":"+JSON.stringify([entry]);
    else {if(!Array.isArray(obj.hooks[event]))fail("Invalid hook event list");if(obj.hooks[event].some(x=>JSON.stringify(x)===JSON.stringify(entry)))return text;keys.push(event);addition=JSON.stringify(entry);}
  }
  const span=locations.get(JSON.stringify(keys)),end=span.end-1;
  const existing=text.slice(span.start+1,end).trim();
  const out=text.slice(0,end)+(existing?",":"")+addition+text.slice(end);JSON.parse(out);return out;
}
const claudeCommand="bash \"$HOME/.errmeter/hooks/claude-code-emit.sh\"";
const claudeEntry={matcher:"*",hooks:[{type:"command",command:claudeCommand}]};
function codexNotify(text,required=true) {
  const lines=text.split("\n");let section=false,index=-1,multi=null;
  for(let i=0;i<lines.length;i++){
    const line=lines[i],startedInString=multi!==null;
    if(!startedInString){if(/^\s*\[/.test(line))section=true;if(!section&&/^\s*notify\s*=/.test(line)){if(index>=0)fail("Duplicate notify setting");index=i;}}
    let quote=null;
    for(let j=0;j<line.length;j++){
      if(multi){if(line.slice(j,j+3)===multi){j+=2;multi=null;}else if(multi.charCodeAt(0)===34&&line[j]==="\\")j++;continue;}
      if(quote){if(quote.charCodeAt(0)===34&&line[j]==="\\")j++;else if(line[j]===quote)quote=null;continue;}
      if(line[j]==="#")break;
      if(line.charCodeAt(j)===34||line.charCodeAt(j)===39){if(line[j+1]===line[j]&&line[j+2]===line[j]){multi=line.slice(j,j+3);j+=2;}else quote=line[j];}
    }
  }
  if(multi)fail("Unterminated TOML multiline string");
  if(index<0){if(required)fail("Missing top-level notify array; add notify = [] first");return {lines,index,prior:null};}
  const raw=lines[index].replace(/^\s*notify\s*=\s*/,"");let prior;
  try{prior=JSON.parse(raw);}catch{fail("Cannot safely parse notify: use a single-line JSON-compatible TOML string array without inline comments");}
  if(!Array.isArray(prior)||!prior.every(v=>typeof v==="string"))fail("Invalid notify array");
  return {lines,index,prior};
}
function desired(target) {
  const files=new Map();
  if(target==="sitter") {
    const rel=rels.sitter[0], text=read(rel,true), snippet=fs.readFileSync(path.join(root,"examples/sitter-on-fail.snippet.sh"),"utf8").trimEnd();
    if(text.includes(snippet))files.set(rel,text);
    else {const lines=text.split("\n"), indexes=lines.flatMap((l,i)=>l.includes("$payload")&&l.includes(">>")&&l.includes("$LOG")?[i]:[]);if(indexes.length!==1)fail("Cannot locate unique sitter JSONL append");lines.splice(indexes[0]+1,0,"# errmeter host hook",snippet);files.set(rel,lines.join("\n"));}
  } else if(target==="claude-code") {
    let text=read(rels[target][0],true);
    text=jsonHook(text,"PostToolUseFailure",claudeEntry);
    files.set(rels[target][0],text);files.set(rels[target][1],fs.readFileSync(path.join(root,"examples/claude-code-emit.sh"),"utf8"));
  } else {
    const rel=rels.codex[0],text=read(rel,true), {lines,index,prior}=codexNotify(text);
    const hook=path.join(home,rels.codex[1]);
    if(!(prior[0]==="bash"&&prior[1]===hook))lines[index]="notify = "+JSON.stringify(["bash",hook,"--previous-notify",JSON.stringify(prior)]);
    files.set(rel,lines.join("\n"));files.set(rels.codex[1],fs.readFileSync(path.join(root,"examples/codex-notify-emit.sh"),"utf8"));
  }return files;
}
function saveBackup(changes,kind) {
  for(const c of changes)safe(c.rel);
  for(const rel of [".errmeter",".errmeter/backups"]){const p=path.join(home,rel);if(stat(p)?.isSymbolicLink())fail("Refusing symlink backup parent");}
  fs.mkdirSync(backupRoot,{recursive:true,mode:0o700});
  const id=new Date().toISOString().replace(/:/g,"-")+"-"+process.pid;
  const dir=path.join(backupRoot,id);fs.mkdirSync(dir,{mode:0o700});
  // Every destination has a byte-exact snapshot (or an explicit absent marker) before any write.
  const entries=changes.map(c=>({...c,before:bytes(c.rel)?.toString("base64")??null,mode:fs.existsSync(safe(c.rel))?fs.statSync(safe(c.rel)).mode&0o777:0o700}));
  fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify({kind,beforeEncoding:"base64",entries},null,2),{mode:0o600,flag:"wx"});return {id,entries};
}
function write(entries) {
  for(const c of entries){const p=safe(c.rel);if(c.after===null){if(fs.existsSync(p))fs.unlinkSync(p);continue;}fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});const tmp=p+".errmeter-"+process.pid;fs.writeFileSync(tmp,c.after,{mode:c.mode,flag:"wx"});fs.renameSync(tmp,p);}
}
function removeEmptyHooksDir() {
  const dir=path.join(home,".errmeter/hooks"), s=stat(dir);
  if(!s)return;
  if(s.isSymbolicLink())fail("Refusing symlink hooks directory");
  if(!s.isDirectory())fail("Hooks path is not a directory");
  if(fs.readdirSync(dir).length===0)fs.rmdirSync(dir);
}
function lastInstalledAfter(history,rel) {
  const manifest=history.find(m=>m.kind==="install"&&Array.isArray(m.entries)&&m.entries.some(e=>e.rel===rel));
  return manifest?.entries.find(e=>e.rel===rel)?.after;
}
function restoredAfterInstall(history,target) {
  const latest=history.find(m=>Array.isArray(m.entries)&&m.entries.some(e=>rels[target].includes(e.rel)));
  return latest?.kind==="restore";
}
function hasClaudeCommand(value) {
  return Boolean(value&&Array.isArray(value.hooks)&&value.hooks.some(h=>h&&h.command===claudeCommand));
}
function targetStatus(target,history) {
  const restored=restoredAfterInstall(history,target);
  if(target==="sitter") {
    const rel=rels.sitter[0], actual=read(rel,true);
    const snippet=fs.readFileSync(path.join(root,"examples/sitter-on-fail.snippet.sh"),"utf8").trimEnd();
    const exactMarker="# errmeter host hook\n"+snippet;
    if(restored)return {state:"not installed",note:false};
    if(actual.includes(exactMarker))return {state:"installed",note:lastInstalledAfter(history,rel)!==undefined&&lastInstalledAfter(history,rel)!==actual};
    return {state:actual.includes("# errmeter host hook")||actual.includes(snippet)?"drifted":"not installed",note:false};
  }
  if(target==="claude-code") {
    const rel=rels[target][0], actual=read(rel,true), hook=read(rels[target][1]);
    const obj=JSON.parse(actual);
    if(!obj||Array.isArray(obj)||typeof obj!=="object")fail("Settings must be a JSON object");
    if(Object.hasOwn(obj,"hooks")&&(!obj.hooks||Array.isArray(obj.hooks)||typeof obj.hooks!=="object"))fail("Invalid hooks object");
    const events=obj.hooks?.PostToolUseFailure;
    if(events!==undefined&&!Array.isArray(events))fail("Invalid hook event list");
    if(restored||hook===null)return {state:"not installed",note:false};
    const markedEntries=events?.filter(hasClaudeCommand)||[], marked=markedEntries.length>0;
    const exact=markedEntries.length===1&&JSON.stringify(markedEntries[0])===JSON.stringify(claudeEntry);
    const hookExample=fs.readFileSync(path.join(root,"examples/claude-code-emit.sh"),"utf8");
    if(hook!==hookExample)return {state:"drifted",note:false};
    if(exact)return {state:"installed",note:lastInstalledAfter(history,rel)!==undefined&&lastInstalledAfter(history,rel)!==actual};
    return {state:marked?"drifted":"not installed",note:false};
  }
  const rel=rels.codex[0], actual=read(rel,true), parsed=codexNotify(actual,false), hook=read(rels.codex[1]);
  if(restored||hook===null)return {state:"not installed",note:false};
  const hookPath=path.join(home,rels.codex[1]);
  const points=parsed.prior!==null&&parsed.prior[0]==="bash"&&parsed.prior[1]===hookPath;
  const hookExample=fs.readFileSync(path.join(root,"examples/codex-notify-emit.sh"),"utf8");
  if(hook!==hookExample)return {state:"drifted",note:false};
  if(points&&hook===hookExample){
    const installed=lastInstalledAfter(history,rel);
    if(installed!==undefined){
      const prior=codexNotify(installed,false).prior;
      const sameNotify=JSON.stringify(prior)===JSON.stringify(parsed.prior);
      return sameNotify?{state:"installed",note:installed!==actual}:{state:"drifted",note:false};
    }
    return {state:"installed",note:false};
  }
  return {state:points?"drifted":"not installed",note:false};
}
let previewRedact;
try {
  if(fs.existsSync(path.join(root,"../../bin/errmeter.js")))previewRedact=require(path.join(root,"../../src/redact.js")).redact;
} catch (_) {}
function minimalRedact(line) {
  return line
    .replace(/(["\x27]?[A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_.-]*["\x27]?\s*[:=]\s*)(["\x27])(?:\\.|(?!\2).)*\2/ig,"$1$2[REDACTED]$2")
    .replace(/([A-Za-z0-9_.-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_.-]*\s*[:=]\s*)[^,;\s}]+/ig,"$1[REDACTED]");
}
function previewLine(line) {console.log(previewRedact?previewRedact(line,[]):minimalRedact(line));}
function boundedDiff(rel,before,after) {
  const a=before.split("\n"),b=after.split("\n");let start=0;
  while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  let ae=a.length-1,be=b.length-1;
  while(ae>=start&&be>=start&&a[ae]===b[be]){ae--;be--;}
  const from=Math.max(0,start-3),aTo=Math.min(a.length-1,ae+3),bTo=Math.min(b.length-1,be+3);
  previewLine("--- ~/"+rel);previewLine("+++ ~/"+rel);previewLine("@@ -"+(from+1)+","+(aTo-from+1)+" +"+(from+1)+","+(bTo-from+1)+" @@");
  for(let i=from;i<start;i++)previewLine(" "+a[i]);
  for(let i=start;i<=ae;i++)previewLine("-"+a[i]);
  for(let i=start;i<=be;i++)previewLine("+"+b[i]);
  for(let i=be+1;i<=bTo;i++)previewLine(" "+b[i]);
}
function previewChange(change) {
  const before=read(change.rel);
  if(change.rel.startsWith(".errmeter/hooks/")&&before===null){
    previewLine("+ ~/"+change.rel+" ("+Buffer.byteLength(change.after)+" bytes, from tools/host-hooks/examples/"+path.basename(change.rel)+")");return;
  }
  if(change.rel===".claude/settings.json"){
    previewLine("--- ~/"+change.rel);previewLine("+++ ~/"+change.rel);previewLine("@@ JSON path $.hooks.PostToolUseFailure @@");previewLine("+ "+JSON.stringify(claudeEntry));return;
  }
  if(change.rel===".codex/config.toml"){
    const oldNotify=codexNotify(before,false),newNotify=codexNotify(change.after);
    previewLine("--- ~/"+change.rel);previewLine("+++ ~/"+change.rel);previewLine("@@ top-level notify @@");
    if(oldNotify.index>=0)previewLine("-"+oldNotify.lines[oldNotify.index]);
    previewLine("+"+newNotify.lines[newNotify.index]);return;
  }
  boundedDiff(change.rel,before||"",change.after);
}
try {
  if(!home||!path.isAbsolute(home))fail("HOME must be an absolute path");
  if(mode==="restore") {
    if(from&&!/^[0-9TZ.-]+$/.test(from)){console.error("Usage error: invalid backup timestamp");process.exit(2);}
    const m=manifests().find(m=>m.kind==="install"&&(!from||m.id===from));if(!m)fail("No installation backup found");
    if(!Array.isArray(m.entries))fail("Invalid backup manifest");
    const changes=m.entries.map(c=>{safe(c.rel);if(c.before!==null&&typeof c.before!=="string")fail("Invalid backup content");const after=c.before===null?null:Buffer.from(c.before,m.beforeEncoding==="base64"?"base64":"utf8");if(after!==null&&m.beforeEncoding==="base64"&&after.toString("base64")!==c.before)fail("Invalid base64 backup");return {rel:c.rel,after,mode:c.mode};}).filter(c=>{const b=bytes(c.rel);return b===null?c.after!==null:c.after===null||!b.equals(c.after);});
    if(!changes.length){removeEmptyHooksDir();console.log("Already restored; no changes.");process.exit(0);}
    const backup=saveBackup(changes,"restore");write(changes);removeEmptyHooksDir();console.log("Restored original bytes from "+m.id+". Replaced files saved in "+backup.id+"; files originally absent removed.");
  } else if(mode==="status") {
    let bad=false,inspected=0,failed=0;const history=manifests();
    for(const t of Object.keys(rels)) {
      try{const result=targetStatus(t,history);inspected++;console.log(t+": "+result.state+(result.note?" (unrelated local edits present)":""));bad ||=result.state!=="installed";}
      catch(error){failed++;console.error(t+": cannot inspect"+(/^Missing file:/.test(error.message)?" (missing file)":": "+error.message));}
    }
    const check=cp.spawnSync("errmeter",["status"],{encoding:"utf8",timeout:10000});
    console.log("errmeter on PATH: "+(check.error&&check.error.code==="ENOENT"?"no":"yes"));
    console.log("errmeter status: "+(check.stdout||check.stderr||"unavailable").trim().split("\n")[0]);process.exitCode=inspected===0?3:(bad||failed?1:0);
  } else {
    const changes=[];
    for(const t of targets)for(const [rel,after] of desired(t)){const before=read(rel);if(before!==after)changes.push({rel,after});}
    if(!changes.length){console.log("Already installed; no changes.");process.exit(0);}
    if(!apply){previewLine("Dry run: no files written. Planned changes (at most 3 context lines):");for(const c of changes)previewChange(c);previewLine("Run again with --apply to install selected targets.");}
    else {const backup=saveBackup(changes,"install");write(backup.entries);console.log("Installed "+targets.join(", ")+". Backup: ~/.errmeter/backups/"+backup.id+"/");}
  }
}catch(error){console.error("Cannot continue: "+error.message);process.exitCode=3;}
' "$ROOT" "$@"
