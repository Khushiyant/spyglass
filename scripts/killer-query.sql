WITH culprit AS (
  SELECT i.id, i.title, i.service, i.first_seen, i.last_seen,
         i.events_count, MAX(p.merged_at) AS pr_merged_at
  FROM reefline_sentry.issues i
  JOIN reefline_github.pulls p
    ON p.service = i.service AND p.state = 'merged'
   AND p.merged_at <= i.first_seen
   AND p.merged_at >= to_char(
         CAST(i.first_seen AS TIMESTAMP) - INTERVAL '24 hours',
         '%Y-%m-%dT%H:%M:%SZ')
  WHERE i.events_count >= 400
  GROUP BY i.id, i.title, i.service, i.first_seen, i.last_seen, i.events_count
)
SELECT
  c.title          AS sentry_issue,
  c.events_count   AS errors,
  c.service,
  p.number         AS pr,
  p.author,
  COUNT(DISTINCT s.id)      AS lost_charges,
  CAST(MAX(m.value) AS INT) AS p99_peak_ms,
  MIN(t.id)        AS ticket
FROM culprit c
JOIN reefline_github.pulls p
  ON p.service = c.service AND p.merged_at = c.pr_merged_at
LEFT JOIN reefline_stripe.charges s
  ON s.status = 'failed'
 AND s.failure_code = 'payment_intent_failed'
 AND s.created BETWEEN c.first_seen AND c.last_seen
LEFT JOIN reefline_datadog.metrics m
  ON m.service = c.service AND m.metric = 'http.latency_p99_ms'
 AND m.timestamp BETWEEN c.first_seen AND c.last_seen
LEFT JOIN reefline_linear.issues t
  ON t.created_at BETWEEN c.first_seen AND c.last_seen
 AND t.priority <= 2
GROUP BY c.title, c.events_count, c.service, p.number, p.author
ORDER BY c.events_count DESC;
