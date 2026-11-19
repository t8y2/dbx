# #12523 修复实测

`sql-format-newlines.png` 展示本分支真实 `QueryEditor.vue` 组件的格式化结果。
在独立的本地 Vue 页面中选择 DBX 排版风格，输入两行无分号的 SELECT 后点击格式化；两条查询仍各占一行，没有插入分号。
此页面使用生产组件和格式化代码，未连接数据库，也未执行 SQL。
