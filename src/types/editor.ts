export type EditNodeKind = "object" | "array" | "value";

export interface EditNode {
  key: string;
  keyName: string;
  kind: EditNodeKind;
  valueText: string;
  readonlyKey: boolean;
  readonlyValue: boolean;
  children: EditNode[];
}
