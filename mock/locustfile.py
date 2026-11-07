"""Example product script for the bundled mock: what /perf-script produces for a small shop API.

Request names are operationIds (PS-D4); createOrder checks the business outcome, not only the
status (PS-B8); each virtual user logs in with its own account (PS-B7).
"""

import itertools
import os

from locust import HttpUser, between, task

# Each ai-perf worker takes its own partition of accounts, so no two workers share one.
_worker = int(os.environ.get("AI_PERF_WORKER", "0"))
_ids = itertools.count(1)


class Buyer(HttpUser):
    wait_time = between(0.05, 0.15)

    def on_start(self):
        r = self.client.post("/login", json={"username": f"perf-w{_worker}-{next(_ids)}"}, name="login")
        self.client.headers["Authorization"] = f"Bearer {r.json().get('token', '')}"

    @task(6)
    def list_items(self):
        self.client.get("/items", name="listItems")

    @task(3)
    def get_item(self):
        self.client.get("/items/7", name="getItem")

    @task(1)
    def create_order(self):
        with self.client.post("/orders", json={"item": 7, "qty": 1}, name="createOrder", catch_response=True) as r:
            if r.status_code != 201 or r.json().get("status") != "created":
                r.failure(f"HTTP {r.status_code}: order not created")
