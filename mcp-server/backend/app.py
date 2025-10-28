import os
import vertexai
from vertexai.generative_models import GenerativeModel, Part, Tool, FunctionDeclaration, Content
from flask import Flask, jsonify, request
from flask_cors import CORS
from datetime import datetime

from google.cloud import storage
import google.auth
from google.oauth2 import credentials as google_credentials

app = Flask(__name__)

CORS(app, resources={r"/api/*": {"origins": "*"}}, headers=['Content-Type', 'Authorization'], supports_credentials=True)

# Initialize Vertex AI
try:
    project_id = os.environ.get("GCP_PROJECT")
    location = os.environ.get("GCP_REGION")
    vertexai.init(project=project_id, location=location)
except Exception as e:
    print(f"Error initializing Vertex AI: {e}")

def list_gcs_buckets_func(project_id, credentials):
    """Lists GCS buckets in a given project using provided credentials."""
    try:
        if not project_id:
            return {"error": "Project ID not provided by the model."}
        storage_client = storage.Client(credentials=credentials, project=project_id)
        buckets = storage_client.list_buckets()
        return {"buckets": [bucket.name for bucket in buckets]}
    except Exception as e:
        return {"error": str(e)}

def get_gcs_bucket_details_func(bucket_name, project_id, credentials):
    """Gets detailed information about a specific GCS bucket."""
    try:
        if not bucket_name:
            return {"error": "Bucket name not provided by the model."}
        if not project_id:
            return {"error": "Project ID not provided by the model for getting bucket details."}

        storage_client = storage.Client(credentials=credentials, project=project_id)
        bucket = storage_client.get_bucket(bucket_name)
        
        details = {
            "name": bucket.name,
            "storage_class": bucket.storage_class,
            "location": bucket.location,
            "location_type": bucket.location_type,
            "time_created": bucket.time_created.isoformat() if bucket.time_created else None,
            "updated": bucket.updated.isoformat() if bucket.updated else None,
            "versioning_enabled": bucket.versioning_enabled,
            "logging": str(bucket.logging) if bucket.logging else None,
            "labels": bucket.labels,
        }
        return details
    except Exception as e:
        return {"error": str(e)}

gcs_tool = Tool(function_declarations=[
    FunctionDeclaration(
        name="list_gcs_buckets",
        description="Lists GCS buckets in a specified Google Cloud project.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "project_id": {
                    "type": "STRING",
                    "description": "The Google Cloud project ID to list buckets from."
                }
            }
        }
    ),
    FunctionDeclaration(
        name="get_gcs_bucket_details",
        description="Gets detailed information about a specific GCS bucket.",
        parameters={
            "type": "OBJECT",
            "properties": {
                "bucket_name": {
                    "type": "STRING",
                    "description": "The name of the GCS bucket to get details for."
                },
                "project_id": {
                    "type": "STRING",
                    "description": "The Google Cloud project ID that the bucket belongs to."
                }
            },
            "required": ["bucket_name", "project_id"]
        }
    )
])

@app.route('/api/prompt', methods=['POST', 'OPTIONS'])
def handle_prompt():
    if request.method == 'OPTIONS':
        return '', 204

    auth_header = request.headers.get('Authorization')
    if not auth_header or not auth_header.startswith('Bearer '):
        return jsonify({'error': 'Authorization (Access Token) not provided or invalid'}), 401

    access_token = auth_header.split(' ')[1]

    try:
        user_credentials = google_credentials.Credentials(access_token)

        data = request.get_json()
        prompt = data.get('prompt')
        if not prompt:
            return jsonify({'error': 'Prompt not provided'}), 400

        model = GenerativeModel("gemini-2.5-flash", tools=[gcs_tool])

        # Convert frontend history to Vertex AI Content objects
        history_from_frontend = data.get('history', [])
        history_for_model = []
        for h in history_from_frontend:
            role = 'model' if h.get('type') == 'bot' else 'user'
            content = h.get('content', '')
            history_for_model.append(Content(role=role, parts=[Part.from_text(content)]))

        chat = model.start_chat(history=history_for_model)
        response = chat.send_message(prompt)

        if response.candidates and response.candidates[0].function_calls:
            function_call = response.candidates[0].function_calls[0]
            if function_call.name == "list_gcs_buckets":
                args = function_call.args
                tool_output = list_gcs_buckets_func(
                    project_id=args.get("project_id"),
                    credentials=user_credentials
                )
                response = chat.send_message(Part.from_function_response(name="list_gcs_buckets", response=tool_output))
            elif function_call.name == "get_gcs_bucket_details":
                args = function_call.args
                tool_output = get_gcs_bucket_details_func(
                    bucket_name=args.get("bucket_name"),
                    project_id=args.get("project_id"),
                    credentials=user_credentials
                )
                response = chat.send_message(Part.from_function_response(name="get_gcs_bucket_details", response=tool_output))

        # Convert Vertex AI history back to frontend format
        final_history_for_frontend = []
        for i, content in enumerate(chat.history):
            content_dict = content.to_dict()
            role = content_dict.get('role')
            if role not in ["user", "model"] or not content_dict.get('parts'):
                continue

            text_parts = [
                part['text']
                for part in content_dict.get('parts', [])
                if 'text' in part
            ]

            if not text_parts:
                continue

            final_history_for_frontend.append({
                "id": f"history-msg-{i}",
                "type": "bot" if role == "model" else "user",
                "content": "\n".join(text_parts),
                "timestamp": datetime.now().isoformat()
            })

        return jsonify({'response': response.text, 'history': final_history_for_frontend})

    except Exception as e:
        print(f"CRITICAL: Main application error: {e}")
        if 'Invalid credential' in str(e):
             return jsonify({'error': f'Invalid or expired access token: {e}'}), 401
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))
    app.run(host='0.0.0.0', port=port)