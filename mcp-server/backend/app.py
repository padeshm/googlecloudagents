import os
import requests
from flask import Flask, jsonify, request
from flask_cors import CORS

app = Flask(__name__)

CORS(app, resources={r"/api/*": {"origins": "*"}}, headers=['Content-Type', 'Authorization'], supports_credentials=True)

MCP_SERVER_URL = os.environ.get("MCP_SERVER_URL")

@app.route('/api/prompt', methods=['POST', 'OPTIONS'])
def handle_prompt():
    if request.method == 'OPTIONS':
        return '', 204

    if not MCP_SERVER_URL:
        return jsonify({'error': 'MCP_SERVER_URL environment variable not set'}), 500

    auth_header = request.headers.get('Authorization')
    if not auth_header:
        return jsonify({'error': 'Authorization header missing'}), 401

    data = request.get_json()

    try:
        # Forward the request to the gcloud-mcp-server
        mcp_response = requests.post(
            f"{MCP_SERVER_URL}/api/prompt",  # Assuming the mcp server has a similar endpoint
            headers={"Authorization": auth_header, "Content-Type": "application/json"},
            json=data,
            timeout=300 # Adding a timeout
        )
        mcp_response.raise_for_status()  # Raise an exception for bad status codes
        
        return jsonify(mcp_response.json())

    except requests.exceptions.RequestException as e:
        return jsonify({'error': f"Failed to connect to MCP server: {e}"}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port)
