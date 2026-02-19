const { runQuery } = require("../services/neo4j.service");

async function test() {
  const res = await runQuery("RETURN 'OK' AS status");
  console.log(res.records[0].get("status"));
}

test().catch(console.error);
