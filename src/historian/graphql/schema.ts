export const typeDefs = /* GraphQL */ `
  type Query {
    screenshot(id: ID!): Screenshot
    screenshots(scadaSystemId: String!, from: String!, to: String!, limit: Int): [Screenshot!]!
    similarScreenshots(screenshotId: ID!, limit: Int, maxDistance: Float): [SimilarResult!]!
    "TEVE text-to-image search: rank screenshots by CLIP similarity to a text query"
    searchScreenshots(query: String!, limit: Int): [SimilarResult!]!
    metrics(scadaSystemId: String!, tagName: String!, from: String!, to: String!): [Metric!]!
    "Nearest metric windows to the window containing 'at' for tag (System.TagName)"
    similarMetricWindows(tag: String!, at: String!, limit: Int): [WindowResult!]!
    anomalies(resolved: Boolean, limit: Int): [Anomaly!]!
    "Similar past incidents, by anomaly signature embedding"
    similarAnomalies(anomalyId: ID!, limit: Int): [AnomalySimilarResult!]!
  }
  type Screenshot {
    id: ID!
    timestamp: String!
    scadaSystemId: String!
    s3Key: String!
    processingStatus: String!
  }
  type SimilarResult { screenshot: Screenshot!, similarity: Float!, distance: Float! }
  type Metric { time: String!, tagName: String!, value: Float, status: String, unit: String }
  type WindowResult {
    scadaSystemId: String!
    tagName: String!
    windowStart: String!
    windowEnd: String!
    sampleCount: Int!
    similarity: Float!
    distance: Float!
  }
  type Anomaly { id: ID!, detectedAt: String!, type: String, score: Float, description: String, resolved: Boolean! }
  type AnomalySimilarResult { anomaly: Anomaly!, similarity: Float!, distance: Float! }
`;
