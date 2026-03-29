const neo4j = require("neo4j-driver");

const NEO4J_URL = process.env.NEO4J_URL || "bolt://localhost:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD;

if (!NEO4J_PASSWORD) {
  console.error('❌ FATAL: NEO4J_PASSWORD environment variable is not set. Exiting.');
  process.exit(1);
}

console.log(`🔌 Initializing Neo4j Driver with URL: ${NEO4J_URL}`);

// Secured URLs (neo4j+s) manage encryption/trust automatically.
// Including them in the config causes a conflict.
const driverConfig = { disableLosslessIntegers: true };
if (!NEO4J_URL.includes("+s")) {
  driverConfig.encrypted = "ENCRYPTION_OFF";
}

const driver = neo4j.driver(
  NEO4J_URL,
  neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD),
  driverConfig
);

async function runQuery(query, params = {}, retryCount = 3) {
  const session = driver.session();
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
