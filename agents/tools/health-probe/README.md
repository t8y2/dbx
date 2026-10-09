# 查询前健康探测验证（V06b / #11472）

此目录是独立验证工具，不进入生产 Agent 包，不提供测试专用生产 API。源码与行为用例已编写，尚未编译或执行。未确认重复探测缺陷，生产健康检查逻辑保持原状。

## 采样口径

`HealthProbe.java` 在独立 JVM 中实例化当前 `OceanBaseOracleAgent`，调用生产 `JsonRpcServer.dispatchForRuntime`；可选生产连接池。仅 JDBC 连接与 Statement 用透明代理计数，不替换数据库执行，也不记录 SQL、绑定值、连接串、用户名、密码或原始错误。

| 字段 | 口径 |
| --- | --- |
| `dispatch_ms` | 进程内 RPC 分派至返回，包括健康检查、连接获取/重连、执行和结果读取；不含 IPC、网络到客户端或渲染 |
| `jdbc_isValid_calls/ms` | JDBC `Connection.isValid` 调用次数/耗时；不等于网络往返数，也不等于 SQL 请求数 |
| `jdbc_statement_execute_calls/ms` | 经代理 Statement 的执行调用，包括 Agent 自身会话设置；不包含驱动内部或 unwrap 后绕过代理的命令 |
| `physical_connect_calls` | 物理驱动连接调用次数，包含失败尝试 |
| `agent_stages_ms` | 生产 QueryTiming 各阶段；阶段可能包含上述 JDBC 耗时，不相加成另一个总时间 |
| `reported_execution_ms` | 既有结果执行口径，保留原值，不命名为数据库纯执行时间 |
| `jdbc_cancel_calls` | 实际送达 Statement 的取消次数；取消竞态中查询已完成不算取消通过 |

冷查询表示显式 connect 后的首个查询；热查询紧接前一个查询；空闲查询等待 5.1 秒跨过非池化验证窗口。失效场景仅关闭本工具创建的物理连接，分别记录窗口内、窗口后的行为；失败不隐藏。重连是显式 disconnect/connect。取消使用固定只读查询竞态，不制造业务长查询或锁。全部查询是固定 `SELECT 1 FROM DUAL`。

## 后续统一执行

必须使用专用测试连接，并在单独 JVM 中运行；工具会替换该进程的 DriverManager 注册以观测真实驱动。不要把 main 加载进桌面或共享 Agent 进程。

在已授权的统一验收阶段，先构建当前固定 SHA 的 OB Agent；将产物绝对路径设为 `$probeAgentJar`，输出目录设为 `$probeClasses`，再执行：

```powershell
javac -cp $probeAgentJar -d $probeClasses agents/tools/health-probe/HealthProbe.java
java -cp "$probeClasses;$probeAgentJar" com.dbx.agent.HealthProbe pooled 20
```

通过当前进程环境设置以下内容，凭据不要放命令参数、脚本正文或日志：

- `DBX_HEALTH_DEDICATED=1`：明确使用可关闭重连的独立测试连接。
- `DBX_HEALTH_CONNECT_JSON`：与现有 connect 协议相同的连接参数；只在进程内解析。
- `DBX_HEALTH_OUTPUT`：一个不存在的 JSONL 文件绝对路径；使用 CREATE_NEW，避免覆盖旧证据。

另用新的输出文件运行 `direct 20`。每次约有两段 5.1 秒等待/样本，勿将不同模式混在同一分布。保存 Git SHA、Agent JAR SHA256、采样日期、版本记录，以及经过脱敏的测试环境/网络条件。初始版本元数据读取在查询测量外单独记录，不能用此工具的 connect 时间作为无探针开销的连接基准。

```powershell
python agents/tools/health-probe/summarize.py <JSONL绝对路径>
```

汇总器按场景和 outcome 分开报告 n/min/p50/p95/max，不混合失败延迟。原始数值样本保留，不能仅凭 p50 或单次差异确认性能问题。

新增常规回归 `:common:test --tests com.dbx.agent.QueryHealthValidationTest` 使用实际 RPC 分派、Agent 和 H2，只在 JDBC 边界注入失效/取消；汇总器回归为 `python -m unittest discover -s agents/tools/health-probe -p test_summarize.py`。上述命令本阶段均未运行。

## 真实网络观测与 Oracle Go/OCI 入口

`wire_relay.py` 是绑定 127.0.0.1 的透明 TCP 中继，完整转发原字节，重组 TCP 分片后仅保存协议类别、帧长度、UTC/单调时间和首个响应时长；不保存 payload/SQL/账号/认证内容。不是生产服务，不进入产品包。连接握手、TLS/压缩、不完整帧、重定向和解码失败单独标注。

OB JDBC 实际使用 MySQL 传输：认证成功后，sequence=0 的 COM_QUERY/COM_PING/COM_STMT_EXECUTE 等分别计数。这是该专用中继内实际命令数，独立于 JDBC 方法调用数；TLS/压缩时只记录 opaque transport，不伪造命令计数。首个响应时长包括中继、网络和服务器等待，并非纯数据库执行时间。

```powershell
python agents/tools/health-probe/wire_relay.py mysql <专用OB主机> <端口> <新wire证据文件> --port 12983 --duration 600
```

中继打印实际 loopback 端口。独立 Java 采样进程设置 `DBX_HEALTH_RELAY_PORT=12983`；工具会只在该进程内覆盖 host/port 指向中继，含自定义 connection_string 时拒绝此模式。原 connect JSON 凭据仍仅在环境内。复用已编译的 HealthProbe 执行 pooled/direct，两模式各使用新 wire 文件和新 sample 文件；启用中继期间的额外延迟必须在环境说明中保留。

```powershell
python agents/tools/health-probe/wire_summary.py <Java-samples-JSONL> <该次wire-JSONL>
```

Oracle Agent 的真实代码在 `agents/drivers/oracle-go`：thin 是 go-ora，OCI 是带 `oci` tag 的 godror/CGO，Rust 负责 Agent 启动环境。`oracle_rpc_probe.py` 启动 root 指定的实际候选 binary，经既有 `open_session/execute_query/validate_session/cancel_session/close_session` JSON-RPC 采样；请求 ID 分流并发取消响应，不使用测试专用生产 API。

```powershell
python agents/tools/health-probe/oracle_rpc_probe.py <thin候选Agent绝对路径> thin <新samples文件> <新wire文件> --samples 20
python agents/tools/health-probe/oracle_rpc_probe.py <OCI候选Agent绝对路径> oci <另一个新samples文件> <另一个新wire文件> --samples 20
python agents/tools/health-probe/wire_summary.py <Oracle-samples-JSONL> <该次wire-JSONL>
```

Oracle 工具共用 `DBX_HEALTH_DEDICATED=1`、`DBX_HEALTH_CONNECT_JSON`，要求简单 host/port/service 参数，拒绝自定义连接描述符，避免绕过中继。保留 profile 和实际 binary SHA256。工具启动自身 TNS 中继后在内存中替换 host/port；不会修改保存的连接。通过关闭本工具的 TCP 流制造真实传输失效，通过 `validate_session` 观察生产恢复；取消时仅暂停专用中继 1 秒，让只读查询等待网络，再发送生产 `cancel_session`，记录成功取消/查询已完成/超时/错误，不强行把结果改成成功。之后继续查询验证恢复。

Oracle 样本的 dispatch_ms 是含进程管道的 JSON-RPC 往返，Java 同名字段是进程内分派，不能直接混合对比。Oracle 另外保留生产结果的 reported_execution_ms；它不等于独立数据库纯执行，server_execute_time 明确未独立测量。线上的首响应时长与 RPC/结果计时各自留证，客户端渲染不在这两个工具范围内。

默认 Oracle 只数实际 TNS 帧，DATA 帧不等于逻辑数据库请求或 SQL 数量。只有独立确认该测试连接没有 TLS/Oracle native encryption，并确认兼容 TTC 后，才可加 `--verified-plaintext-ttc`，记录帧前缀中可确认的 TTC ping/OALL8 等类别及首响应时长下界。未解析 piggyback/跨帧 TTC、加密数据或 OCI 版本差异时明确 incomplete/unknown，不声明完整逻辑请求总数。TNS 重定向可能绕过中继，看到 redirect 或目标流未捕获时验收不完整；不能为了取数自动关闭安全设置。

这些实际协议观测的固定依据：go-ora [v2.9.0 connection.go Ping](https://github.com/sijms/go-ora/blob/v2.9.0/v2/connection.go)、[simple_object.go](https://github.com/sijms/go-ora/blob/v2.9.0/v2/simple_object.go)、[network/data_packet.go](https://github.com/sijms/go-ora/blob/v2.9.0/v2/network/data_packet.go)、[accept_packet.go](https://github.com/sijms/go-ora/blob/v2.9.0/v2/network/accept_packet.go)。实际生产驱动版本若变化须重新核对，不拿 parser fixture 当目标版本已支持。

新增 `test_wire_relay.py` 覆盖 TCP 分片/合帧、真实 loopback 字节转发、认证和 TLS 边界、TNS 16/32 位帧、默认不解码逻辑请求、显式明文 TTC 下界、首响应口径、窗口关联与错误脱敏。统一运行 Python suite 时使用 `python -m unittest discover -s agents/tools/health-probe -p "test_*.py"`，包含汇总和网络用例。源码仅做语法解析，未执行。

## 尚待实证

JDBC 计数不能证明真实网络请求数。现在已有上述真实传输观测入口，仍须在目标版本/权限/网络条件下实际运行并核对覆盖。TLS/压缩、Oracle 加密、跨帧 TTC 或重定向使逻辑请求数不可确认时保留未验证边界；不能用 JDBC/RPC/TNS DATA 数替代，不为普通查询新增 SQL_AUDIT 补查。

Oracle Go/OCI 使用上述生产 Agent 入口独立测量；Java 工具不代表它。客户端 Tauri IPC/传输/渲染仍需真实桌面证据。现有网络失效/暂停/取消场景已编写但未执行；实际数据库不可达、真实探测阻塞与成功取消仍须核对结果。当前没有实库样本、性能结论、修复前后对比或 GUI 通过结论。

若后续确认重复探测或阻塞缺陷，再为实际调用链写失败回归并做最小修复；保留失效检测和错误分类，经独立 Standards/Spec、固定 SHA CI 后交付。无缺陷时记录保留现状的证据，不为性能猜测修改生产行为。
