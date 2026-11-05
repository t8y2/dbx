package model

// LabOrder is synthetic data only. No production schema is imported.
type LabOrder struct {
 ID int64 `gorm:"primaryKey;autoIncrement:false"`
 Status string `gorm:"not null"`
 Amount int64 `gorm:"not null"`
}
func (LabOrder) TableName() string { return "fault_gen_orders" }
