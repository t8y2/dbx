import { recordMongoScriptCommands } from "./mongoScriptRecorder";

self.onmessage = (event: MessageEvent<{ script: string }>) => {
  self.postMessage(recordMongoScriptCommands(event.data.script));
};
