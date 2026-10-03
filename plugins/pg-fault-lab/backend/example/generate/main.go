package main

import (
 "gorm.io/gen"
 "github.com/xue-ding-e/dbx/plugins/pg-fault-lab/example/model"
)
func main(){g:=gen.NewGenerator(gen.Config{OutPath:"query",Mode:gen.WithDefaultQuery|gen.WithQueryInterface});g.ApplyBasic(model.LabOrder{});g.Execute()}
