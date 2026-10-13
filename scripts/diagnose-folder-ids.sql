-- 诊断脚本：检查 saved_sql_files 表中的 folder_id 数据
-- 运行此脚本查看哪些文件的 folder_id 有问题

SELECT 
  f.id,
  f.name,
  f.folder_id,
  CASE 
    WHEN f.folder_id IS NULL THEN 'NULL'
    WHEN f.folder_id = '' THEN 'EMPTY_STRING'
    ELSE 'HAS_VALUE'
  END as folder_id_status,
  fo.name as folder_name
FROM saved_sql_files f
LEFT JOIN saved_sql_folders fo ON f.folder_id = fo.id
ORDER BY f.folder_id, f.order_index;

-- 检查是否有文件应该在文件夹内但 folder_id 为空
-- （通过文件名或其他线索判断）
SELECT 
  id,
  name,
  folder_id,
  connection_id
FROM saved_sql_files
WHERE folder_id IS NULL OR folder_id = ''
ORDER BY updated_at DESC;
