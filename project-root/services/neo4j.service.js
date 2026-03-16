const neo4j = require("neo4j-driver");

const NEO4J_URL = process.env.NEO4J_URL || "bolt://localhost:7687";
console.log(`🔌 Initializing Neo4j Driver with URL: ${NEO4J_URL}`);

const driver = neo4j.driver(
  NEO4J_URL,
  neo4j.auth.basic("neo4j", "HelloWorld@4321"),
  {
    encrypted: "ENCRYPTION_OFF",
    trust: "TRUST_ALL_CERTIFICATES",
    disableLosslessIntegers: true
  }
);

async function runQuery(query, params = {}, retryCount = 3) {
  const session = driver.session({ database: "neo4j" });
  try {
    return await session.run(query, params);
  } catch (error) {
    if (retryCount > 0 && error.code === 'ServiceUnavailable') {
      console.log(`⚠️ Neo4j unavailable, retrying... (${retryCount} attempts left)`);
      await new Promise(resolve => setTimeout(resolve, 3000));
      return runQuery(query, params, retryCount - 1);
    }
    throw error;
  } finally {
    await session.close();
  }
}

module.exports = { runQuery };
