-- 检查 saved_sql_files 表中的 folder_id 数据
SELECT 
  id,
  name,
  folder_id,
  CASE 
    WHEN folder_id IS NULL THEN 'NULL'
    WHEN folder_id = '' THEN 'EMPTY_STRING'
    ELSE 'HAS_VALUE'
  END as folder_id_status
FROM saved_sql_files
ORDER BY folder_id, order_index;

-- 检查 saved_sql_folders 表
SELECT 
  id,
  name,
  parent_folder_id,
  connection_id
FROM saved_sql_folders
ORDER BY parent_folder_id, order_index;
