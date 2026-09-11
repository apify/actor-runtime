"""The non-standard sample Actor's body - Python standard library only, no Apify SDK.

Everything it needs comes from the environment variables the runtime sets for every Actor container
(`actor-driver.md`'s "Environment variables in every Actor container"), and everything it does goes
over plain HTTP to `APIFY_API_BASE_URL`. That is the point: an Actor that never imports `apify` still
gets its input, its default storages and its log, exactly like an SDK-based one.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

# Printed by the runtime's own log as an ordinary Actor line; the e2e suite asserts on it to prove the
# dev-folder bind mount actually replaced this file.
FINISHED_MARKER = 'Non-standard Actor finished.'

API_BASE_URL = os.environ['APIFY_API_BASE_URL'].rstrip('/')
TOKEN = os.environ['APIFY_TOKEN']


def api_request(method: str, path: str, body: object | None = None) -> bytes | None:
    """One authenticated call against the runtime's API. Returns `None` for a 404."""
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f'{API_BASE_URL}/v2/{path}', data=data, method=method)
    request.add_header('authorization', f'Bearer {TOKEN}')
    if data is not None:
        request.add_header('content-type', 'application/json')
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read()
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return None
        raise


def main() -> None:
    print(f'main.py: interpreter {sys.executable}, argv {sys.argv}')
    print(f'main.py: working directory {os.getcwd()}')
    # Proof that the platform contract vars reach an Actor that knows nothing about the Apify SDK.
    print(f'main.py: APIFY_IS_AT_HOME={os.environ.get("APIFY_IS_AT_HOME")}')
    print(f'main.py: ACTOR_RUN_ID={os.environ.get("ACTOR_RUN_ID")}')

    key_value_store_id = os.environ['APIFY_DEFAULT_KEY_VALUE_STORE_ID']
    dataset_id = os.environ['APIFY_DEFAULT_DATASET_ID']

    raw_input = api_request('GET', f'key-value-stores/{key_value_store_id}/records/INPUT')
    actor_input = json.loads(raw_input) if raw_input else {}
    item_count = int(actor_input.get('itemCount', 2))
    print(f'main.py: pushing {item_count} item(s) to dataset {dataset_id}.')

    # Deliberately both accepted body shapes of `POST /v2/datasets/:id/items`: a single object for the
    # first item, an array for the rest.
    if item_count > 0:
        api_request('POST', f'datasets/{dataset_id}/items', {'index': 0, 'source': 'nonstandard'})
    if item_count > 1:
        api_request(
            'POST',
            f'datasets/{dataset_id}/items',
            [{'index': index, 'source': 'nonstandard'} for index in range(1, item_count)],
        )

    api_request(
        'PUT',
        f'key-value-stores/{key_value_store_id}/records/OUTPUT',
        {'itemCount': item_count, 'workingDirectory': os.getcwd()},
    )

    print(FINISHED_MARKER)


if __name__ == '__main__':
    main()
