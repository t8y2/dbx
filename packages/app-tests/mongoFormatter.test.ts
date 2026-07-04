import { strict as assert } from "node:assert";
import { test } from "vitest";
import { formatMongoShellText, MAX_MONGO_FORMAT_CHARS } from "../../apps/desktop/src/lib/mongo/mongoFormatter.ts";

test("formats MongoDB find query objects", () => {
    assert.equal(
        formatMongoShellText('db.characters.find({name:"Ada",age:{$gte:18,$lt:30}}).sort({createdAt:-1}).limit(20)'),
        `db.characters.find({
  name: "Ada",
  age: {
    $gte: 18,
    $lt: 30
  }
})
  .sort({
    createdAt: -1
  })
  .limit(20)`,
    );
});

test("formats MongoDB aggregation pipelines", () => {
    assert.equal(
        formatMongoShellText('db.orders.aggregate([{$match:{status:"paid"}},{$group:{_id:"$userId",total:{$sum:"$amount"}}}])'),
        `db.orders.aggregate([
  {
    $match: {
      status: "paid"
    }
  },
  {
    $group: {
      _id: "$userId",
      total: {
        $sum: "$amount"
      }
    }
  }
])`,
    );
});

test("preserves strings, regex literals, and comments", () => {
    assert.equal(
        formatMongoShellText('db.users.find({name:/a,b\\/c/i,note:"x,y",active:true}) // keep comment'),
        `db.users.find({
  name: /a,b\\/c/i,
  note: "x,y",
  active: true
}) // keep comment`,
    );
});

test("respects tab indentation setting", () => {
    assert.equal(
        formatMongoShellText("db.users.find({name:'Ada'})", { useTabs: true, tabWidth: 4 }),
        "db.users.find({\n\tname: 'Ada'\n})",
    );
});

test("leaves blank MongoDB text unchanged", () => {
    assert.equal(formatMongoShellText("  \n\t"), "  \n\t");
});

test("rejects very large MongoDB queries", () => {
    assert.throws(() => formatMongoShellText("x".repeat(MAX_MONGO_FORMAT_CHARS + 1)), /too large/i);
});
