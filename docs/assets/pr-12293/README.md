# #12293 修复实测

两张截图均来自独立本地页面内的生产 `QueryEditor.vue`，使用 MySQL 方言、手动触发补全，未连接远程服务：

- `parameter-completion.png`：输入 `p_` 后出现 `p_input`，回车插入正确参数名。
- `local-variable-completion.png`：输入 `v_` 后出现 `v_local`，回车插入正确变量名。

另外在本机 Docker MySQL 8.4.6 中创建独立临时库，实测了过程参数、局部变量、嵌套 BEGIN..END、IF 和单 RETURN 函数。
过程输入 7，计算 7 + 1 + 3 + 1，结果 12；函数输入 7，结果 8。实测结束后清理了该临时测试库。

相关行为测试还覆盖方向参数、逗号声明、嵌套作用域、大小写和同名变量、DELIMITER 脚本、注释/字符串、条件和游标声明过滤，以及其他方言的兼容性。
