FLOWDOCTOR — WEB BETA v0.2

HOW TO OPEN (NO CODING REQUIRED)
1. Unzip the FlowDoctor-Launch.zip archive.
2. Double-click index.html.
3. Click "Load sample" then "Analyze workflow".
4. To analyze your n8n workflow, export it as JSON in n8n and select the file.

PUBLISH ONLINE
The index.html file is a static website. You can publish it with a static-site hosting provider, for example by deploying the containing folder using Netlify Drop (https://app.netlify.com/drop). Check the hosting provider's terms and account age requirements.

IMPORTANT LIMITATIONS
- No payment processing or user account yet.
- AI analysis is not connected yet; it uses deterministic and heuristic rules.
- Not a runtime test or security certification.
- Workflow JSON is processed in the browser; none is sent to FlowDoctor servers.
- The analyzer checks some common issues, not every n8n node configuration.
- If you share the public deployment, test carefully and do not claim it guarantees workflow correctness.
