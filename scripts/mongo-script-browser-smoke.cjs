// UI-driven browser harness for the real sandbox module. No database connections.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");
const root = path.resolve(__dirname, "../apps/desktop/src/lib/mongo");
const worker = fs.readFileSync(path.join(root, "mongoScriptWorker.js"), "utf8");
const source = fs.readFileSync(path.join(root, "mongoScriptSandbox.ts"), "utf8")
  .replace('import workerSource from "./mongoScriptWorker.js?raw";', "const workerSource = " + JSON.stringify(worker) + ";")
  .replace('import { uuid } from "@/lib/common/utils";', "const uuid = () => crypto.randomUUID();");
const moduleJs = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2021, module: ts.ModuleKind.ESNext } }).outputText;
const html =  '<!doctype html><html><head><meta charset="utf-8"><title>DBX script sandbox smoke</title></head><body>' +
  '<h1>DBX script sandbox smoke</h1><p>No database connections. Mocked document reads only.</p>' +
  '<button id="functional">Functions, loops and RPC</button><button id="isolation">Network and storage isolation</button><button id="timeout">Infinite loop timeout</button><pre id="result" role="status">Ready</pre>' +
  '<script type="module">import {runMongoScriptSandbox} from "/sandbox.js";' +
  'const result=document.querySelector("#result"); async function test(source, timeoutMs=3000) { result.textContent="Running"; const logs=[]; const session=runMongoScriptSandbox(source,{timeoutMs,log: values=>logs.push(values),request: async()=>[{n:3},{n:4}]}); try {await session.completion; result.textContent="PASS: "+JSON.stringify(logs);} catch(e) {result.textContent="STOPPED: "+e.message;} }' +
  'document.querySelector("#functional").onclick=()=>test(' + JSON.stringify('const docs=await db.items.find({}).toArray(); function twice(n){return n*2;} let total=0; for(const doc of docs) total+=twice(doc.n); print(total);') + ');' +
  'document.querySelector("#isolation").onclick=()=>test(' + JSON.stringify('let blocked=false; try {await fetch("http://127.0.0.1:5189/probe");} catch {blocked=true;} print({networkBlocked:blocked,document:typeof document,localStorage:typeof localStorage});') + ');' +
  'document.querySelector("#timeout").onclick=()=>test(' + JSON.stringify('while(true) {}') + ', 1000);' +
  '</script></body></html>';
http.createServer((request, response) => {
  if (request.url === "/probe") { console.error("UNEXPECTED sandbox network request"); response.writeHead(403); response.end(); return; }
  response.setHeader("Content-Type", request.url === "/sandbox.js" ? "application/javascript" : "text/html; charset=utf-8");
  response.end(request.url === "/sandbox.js" ? moduleJs : html);
}).listen(5189, "127.0.0.1", () => console.log("Sandbox smoke UI: http://127.0.0.1:5189"));
