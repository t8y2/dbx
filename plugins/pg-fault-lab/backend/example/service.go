package example

import (
	"context"
	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/example/model"
	"github.com/xue-ding-e/dbx/plugins/pg-fault-lab/example/query"
	"gorm.io/gorm"
)

// PlaceOrder is an ordinary gorm-gen transaction over generated typed queries.
// It needs no proxy SDK: callers pass their existing GORM database connection.
func PlaceOrder(ctx context.Context, db *gorm.DB, id, amount int64) error {
	return query.Use(db).Transaction(func(tx *query.Query) error {
		order := tx.LabOrder
		if err := order.WithContext(ctx).Create(&model.LabOrder{ID: id, Status: "draft", Amount: amount}); err != nil {
			return err
		}
		_, err := order.WithContext(ctx).Where(order.ID.Eq(id)).Update(order.Status, "paid")
		return err
	})
}

// PlaceOrderGORM runs the same synthetic business operation with ordinary GORM.
func PlaceOrderGORM(ctx context.Context, db *gorm.DB, id, amount int64) error {
	return db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		order := model.LabOrder{ID: id, Status: "draft", Amount: amount}
		if err := tx.Create(&order).Error; err != nil {
			return err
		}
		return tx.Model(&model.LabOrder{}).Where("id = ?", id).Update("status", "paid").Error
	})
}
