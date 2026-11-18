// Each phase's `run` is a JS expression evaluated in the page; `bench` is window.bench.
const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index)).join("\n");

export const dataList = (count) => `SELECT * FROM orders WHERE code IN (\n${lines(count, (index) => `'LTA${String(372621040 + index).padStart(9, "0")}',`)}\n'LTA000000000');`;

export const oneLineList = (count) => `SELECT * FROM orders WHERE code IN (${Array.from({ length: count }, (_, index) => `'LTA${String(372621040 + index).padStart(9, "0")}'`).join(",")});`;

export const storedProcedure = (count) =>
  `CREATE PROCEDURE dbo.usp_big AS\nBEGIN\n${lines(count, (index) => `  IF EXISTS (SELECT 1 FROM dbo.orders o JOIN dbo.customers c ON c.id = o.customer_id WHERE o.id = ${index}) UPDATE dbo.orders SET total = total + ${index} WHERE id = ${index}; -- step ${index}`)}\nEND`;

export const mybatis = (count) => lines(count, (index) => (index % 5 === 0 ? `<if test="field${index} != null">` : index % 5 === 4 ? `</if>` : `  AND t.col_${index} = #{field${index}}`));

const js = (value) => JSON.stringify(value);

const typeAndSelect = (docExpression, label) => [
  { name: `${label}: mount`, run: `bench.mount(${docExpression})` },
  { name: `${label}: type 30 chars at end`, run: `bench.measure('type-end', () => bench.type('abcdefghij1234567890abcdefghij'))` },
  { name: `${label}: type 30 chars in middle`, run: `bench.measure('type-mid', () => bench.type('abcdefghij1234567890abcdefghij', { position: 'middle' }))` },
  { name: `${label}: select all`, run: `bench.measure('select-all', () => bench.selectAll())` },
  { name: `${label}: drag select`, run: `bench.measure('drag', () => bench.dragSelect(5, 250))` },
  { name: `${label}: drag profile`, run: `bench.dragProfile(5, 250)` },
  { name: `${label}: scroll`, run: `bench.measure('scroll', () => bench.scrollThrough())` },
];

export const scenarios = [
  { name: "data-list-100k", phases: typeAndSelect(js(dataList(100_000)), "100k data lines") },
  { name: "data-list-10k", phases: typeAndSelect(js(dataList(10_000)), "10k data lines") },
  { name: "oneline-100k", phases: typeAndSelect(js(oneLineList(100_000)), "100k values on one line") },
  { name: "oneline-10k", phases: typeAndSelect(js(oneLineList(10_000)), "10k values on one line") },
  { name: "procedure-300", phases: typeAndSelect(js(storedProcedure(300)), "300-line procedure") },
  { name: "mybatis-300", phases: typeAndSelect(js(mybatis(300)), "300-line mybatis") },
  {
    name: "multi-tab-5x200",
    phases: [
      { name: "mount 5 editors", run: `bench.mount(${js(storedProcedure(200))}, { count: 5 })` },
      { name: "type in last", run: `bench.measure('type', () => bench.type('abcdefghij1234567890abcdefghij', { index: 4, position: 'end' }))` },
    ],
  },
];
