const MAX_BYTES = 2 * 1024 * 1024;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function analyzeText(text) {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('File exceeds the 2 MB limit.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid JSON. Export a workflow from n8n and try again.'); }
  return analyzeWorkflow(data);
}

export function analyzeWorkflow(data) {
  if (!isObject(data) || !Array.isArray(data.nodes) || !isObject(data.connections)) {
    throw new Error('This does not look like an n8n workflow: nodes[] and connections{} are required.');
  }
  if (data.nodes.length > 5000) throw new Error('More than 5,000 nodes are not supported.');
  const issues = [];
  const add = (rule, severity, node, title, explanation, fix, certainty = 'deterministic') =>
    issues.push({ id: `${rule}-${issues.length + 1}`, rule, severity, node, title, explanation, fix, certainty });
  const names = new Map();
  const ids = new Set();
  const nodes = data.nodes;
  for (const [index, n] of nodes.entries()) {
    if (!isObject(n) || typeof n.name !== 'string' || !n.name.trim() || typeof n.type !== 'string') {
      add('INVALID_NODE', 'High', `Node ${index + 1}`, 'Invalid node structure', 'A node is missing its name or type.', 'Check the exported node fields.');
      continue;
    }
    names.set(n.name, (names.get(n.name) || 0) + 1);
    if (n.id != null) {
      if (ids.has(n.id)) add('DUPLICATE_ID', 'High', n.name, 'Duplicate node ID', 'Multiple nodes share an ID.', 'Assign unique node IDs.');
      ids.add(n.id);
    }
  }
  for (const [name, count] of names) if (count > 1) add('DUPLICATE_NAME', 'High', name, 'Duplicate node name', `${count} nodes have the same name; connections may be ambiguous.`, 'Rename nodes uniquely.');
  const edges = new Map();
  const indegree = new Map([...names.keys()].map(name => [name, 0]));
  for (const [source, outputs] of Object.entries(data.connections)) {
    if (!names.has(source)) {
      add('UNKNOWN_SOURCE', 'High', source, 'Connection source missing', 'A connection refers to a source not present in the workflow.', 'Remove the broken connection or restore its source node.');
    }
    if (!isObject(outputs)) continue;
    for (const groups of Object.values(outputs)) {
      if (!Array.isArray(groups)) continue;
      for (const targets of groups) {
        if (!Array.isArray(targets)) continue;
        for (const target of targets) {
          if (!isObject(target) || typeof target.node !== 'string') continue;
          if (!names.has(target.node)) {
            add('UNKNOWN_TARGET', 'High', source, 'Connection target missing', `Target node '${target.node}' is not present.`, 'Reconnect the source to an existing node.');
          } else {
            if (!edges.has(source)) edges.set(source, new Set());
            edges.get(source).add(target.node);
            indegree.set(target.node, (indegree.get(target.node) || 0) + 1);
          }
        }
      }
    }
  }
  const triggerNodes = nodes.filter(n => isObject(n) && typeof n.type === 'string' && (/trigger/i.test(n.type) || /webhook/i.test(n.type)) && !n.disabled).map(n => n.name);
  if (!nodes.length) add('EMPTY', 'Medium', 'Workflow', 'Empty workflow', 'No nodes were found.', 'Add a trigger and action nodes.');
  if (nodes.length && !triggerNodes.length) add('NO_TRIGGER', 'Medium', 'Workflow', 'No recognizable trigger', 'No enabled trigger was identified by the simple type-name rule; manual execution or custom triggers may be intentional.', 'Confirm how the workflow is started.', 'heuristic');
  const visited = new Set();
  const stack = [...triggerNodes];
  while (stack.length) {
    const name = stack.pop();
    if (visited.has(name)) continue;
    visited.add(name);
    for (const target of edges.get(name) || []) if (!visited.has(target)) stack.push(target);
  }
  if (triggerNodes.length) {
    for (const n of nodes) {
      if (isObject(n) && typeof n.name === 'string' && !n.disabled && !visited.has(n.name)) {
        add('UNREACHABLE', 'Medium', n.name, 'Node not reachable from detected triggers', 'No connection path from an identified trigger reaches this node.', 'Review the wiring; separate or manually invoked branches may be intentional.', 'heuristic');
      }
    }
  }
  const errorConfigured = isObject(data.settings) && typeof data.settings.errorWorkflow === 'string' && data.settings.errorWorkflow.length > 0;
  if (nodes.length && !errorConfigured) add('ERROR_WORKFLOW', 'Low', 'Workflow', 'No error workflow configured', 'The exported settings do not reference an error workflow. This may be intentional.', 'Consider an error workflow for notifications and recovery.', 'heuristic');
  for (const n of nodes) {
    if (!isObject(n) || typeof n.type !== 'string' || typeof n.name !== 'string') continue;
    if (/httpRequest/i.test(n.type) && n.retryOnFail !== true) {
      add('HTTP_RETRY', 'Low', n.name, 'HTTP request without node retry', 'Node-level retryOnFail is not enabled; retries may be handled elsewhere.', 'Consider retries/backoff for transient failures, ensuring requests are safe to repeat.', 'heuristic');
    }
    // Scan field names only. Never display or export sensitive field values.
    function scanFields(value, depth = 0) {
      if (depth > 12 || !isObject(value)) return false;
      return Object.entries(value).some(([key, v]) => {
        if (/^(api[_-]?key|access[_-]?token|client[_-]?secret|password|private[_-]?key)$/i.test(key) && typeof v === 'string' && v.length > 0 && !/^\{\{.*\}\}$/.test(v)) return true;
        if (isObject(v)) return scanFields(v, depth + 1);
        if (Array.isArray(v)) return v.some(item => isObject(item) && scanFields(item, depth + 1));
        return false;
      });
    }
    if (scanFields(n.parameters)) add('POSSIBLE_SECRET', 'High', n.name, 'Possible embedded secret', 'A sensitive-looking parameter name contains a string value. This is not proof of a live credential.', 'Review locally and use n8n credentials or environment variables where appropriate.', 'heuristic');
  }
  const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
  issues.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    name: typeof data.name === 'string' ? data.name : 'Untitled workflow',
    nodeCount: nodes.length,
    connectionCount: [...edges.values()].reduce((sum, set) => sum + set.size, 0),
    types: [...new Set(nodes.filter(isObject).map(n => n.type).filter(x => typeof x === 'string'))].sort(),
    issues,
    disclaimer: 'Static checks only. No execution, dependency validation or guarantee of security or correctness.'
  };
}
