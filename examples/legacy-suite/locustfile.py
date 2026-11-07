"""A legacy Locust suite with planted defects (see load-test.js). Not for running."""
from locust import HttpUser, task


class Shopper(HttpUser):
    def on_start(self):
        self.client.post("/login", json={"username": "loadtest", "password": "x"})

    @task(5)
    def browse(self):
        self.client.get("/items/42")

    @task(1)
    def buy(self):
        self.client.post("/orders", json={"item": 7})
