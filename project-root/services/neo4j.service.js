const neo4j = require("neo4j-driver");

const driver = neo4j.driver(
  "bolt://localhost:7687",
  neo4j.auth.basic("neo4j", "HelloWorld@4321"),
  {
    encrypted: "ENCRYPTION_OFF" ,
    disableLosslessIntegers: true
  }
);

async function runQuery(query, params = {}) {
  const session = driver.session({database: "neo4j"} );
  try {
    return await session.run(query, params);
  } finally {
    await session.close();
  }
}

module.exports = { runQuery };
