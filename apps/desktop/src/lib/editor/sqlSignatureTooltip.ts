import type { SqlFunctionSignatureHelp } from "@/lib/sql/sqlCompletion";

export function createSqlSignatureTooltipDom(signature: SqlFunctionSignatureHelp | null): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md";
  if (!signature) return dom;

  signature.overloads.forEach((overload, overloadIndex) => {
    const row = document.createElement("div");
    row.className = overloadIndex > 0 ? "mt-1 flex items-center gap-2 font-mono" : "flex items-center gap-2 font-mono";
    if (signature.overloads.length > 1) {
      const count = document.createElement("span");
      count.className = "text-[10px] text-muted-foreground";
      count.textContent = `${overloadIndex + 1}/${signature.overloads.length}`;
      row.appendChild(count);
    }

    const call = document.createElement("span");
    const name = document.createElement("span");
    name.className = "text-muted-foreground";
    name.textContent = signature.name;
    call.appendChild(name);

    overload.parameterGroups.forEach((group, groupIndex) => {
      const open = document.createElement("span");
      open.className = "text-muted-foreground";
      open.textContent = "(";
      call.appendChild(open);
      group.forEach((parameter, parameterIndex) => {
        if (parameterIndex > 0) call.append(", ");
        const node = document.createElement("span");
        const active = groupIndex === overload.activeGroup && parameterIndex === overload.activeParameter;
        node.className = active ? "font-semibold text-foreground" : "text-muted-foreground";
        if (active) node.dataset.activeParameter = "true";
        node.textContent = parameter;
        call.appendChild(node);
      });
      call.append(")");
    });

    row.appendChild(call);
    dom.appendChild(row);
  });
  return dom;
}
