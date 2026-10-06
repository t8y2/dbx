// @ts-nocheck
export function evaluateMongoScript(script: string): { commands: string[]; prints: string[] } | null {
  const commands: any[] = [];
  const prints: string[] = [];

  function createMockCursor(collection: string, method: string, args: any[]): any {
    const capture = { collection, method, args, chains: [] as any[] };
    commands.push(capture);

    const cursor: any = new Proxy(
      {},
      {
        get(target, prop) {
          return (...chainArgs: any[]) => {
            capture.chains.push({ prop, chainArgs });
            return cursor;
          };
        },
      },
    );
    return cursor;
  }

  const db: any = new Proxy(
    {},
    {
      get(target, collection: string) {
        return new Proxy(
          {},
          {
            get(t, method: string) {
              return function (...args: any[]) {
                return createMockCursor(collection, method, args);
              };
            },
          },
        );
      },
    },
  );

  const print = (...args: any[]) => {
    prints.push(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "));
  };

  const globalScope = {
    ObjectId: (id: string) => ({ __mongoType: "ObjectId", value: id }),
    ISODate: (date: string) => ({ __mongoType: "ISODate", value: date }),
    UUID: (id: string) => ({ __mongoType: "UUID", value: id }),
  };

  try {
    const args = ["db", "print", ...Object.keys(globalScope)];
    const fn = new Function(...args, script);
    fn(db, print, ...Object.values(globalScope));

    const serializeArg = (arg: any): string => {
      if (arg && typeof arg === "object" && arg.__mongoType) {
        if (arg.__mongoType === "ObjectId") return `ObjectId("${arg.value}")`;
        if (arg.__mongoType === "ISODate") return `ISODate("${arg.value}")`;
        if (arg.__mongoType === "UUID") return `UUID("${arg.value}")`;
      }
      return JSON.stringify(arg, (key, value) => {
        if (value && typeof value === "object" && value.__mongoType) {
          return `__MONGO_${value.__mongoType}__${value.value}__`;
        }
        return value;
      });
    };

    const postProcessJSON = (json: string) => {
      return json.replace(/"__MONGO_([a-zA-Z]+)__([^"]+)__"/g, '$1("$2")');
    };

    const generatedCommands = commands.map((capture) => {
      const argsStr = capture.args.map((a: any) => postProcessJSON(serializeArg(a))).join(", ");
      let s = `db.${capture.collection}.${capture.method}(${argsStr})`;
      for (const chain of capture.chains) {
        const chainArgsStr = chain.chainArgs.map((a: any) => postProcessJSON(serializeArg(a))).join(", ");
        s += `.${String(chain.prop)}(${chainArgsStr})`;
      }
      return s;
    });

    return { commands: generatedCommands, prints };
  } catch (e) {
    return null;
  }
}
