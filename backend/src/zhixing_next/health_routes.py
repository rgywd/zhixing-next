"""Model-independent health API. Authentication is inherited from /v1."""

from typing import Annotated

from fastapi import APIRouter, Query

from .health_service import (
    FeedbackInput,
    HealthService,
    MealInput,
    ProfileInput,
    RecommendationInput,
    RemindersInput,
    RuleInput,
    StepsInput,
    WeightInput,
)


def create_router(store):
    router = APIRouter(prefix="/health")
    service = HealthService(store)

    @router.get("/summary")
    def summary(date: str | None = None):
        return service.summary(date)

    @router.get("/profile")
    def profile():
        return service.profile()

    @router.put("/profile")
    def set_profile(body: ProfileInput):
        return service.set_profile(body.model_dump())

    @router.get("/reminders")
    def reminders():
        return service.reminders()

    @router.put("/reminders")
    def set_reminders(body: RemindersInput):
        return service.set_reminders(body.model_dump())

    def add_crud(kind, model):
        # Define explicitly annotated functions; FastAPI resolves these concrete
        # body schemas for validation rather than reflecting arbitrary payloads.
        def listing(start: str | None = None, end: str | None = None,
                    limit: Annotated[int, Query(ge=1, le=500)] = 100):
            return service.list(kind, start=start, end=end, limit=limit)

        def creating(body):
            return service.create(kind, body.model_dump())

        def updating(identifier: str, body):
            return service.update(kind, identifier, body.model_dump())

        def deleting(identifier: str, revision: Annotated[int, Query(ge=1)]):
            return service.delete(kind, identifier, revision)

        creating.__annotations__["body"] = model
        updating.__annotations__["body"] = model
        router.add_api_route(f"/{kind}", listing, methods=["GET"], name=f"list_health_{kind}")
        router.add_api_route(f"/{kind}", creating, methods=["POST"], status_code=201, name=f"create_health_{kind}")
        if kind != "recommendations":
            router.add_api_route(f"/{kind}/{{identifier}}", updating, methods=["PUT"], name=f"update_health_{kind}")
            router.add_api_route(f"/{kind}/{{identifier}}", deleting, methods=["DELETE"], name=f"delete_health_{kind}")

    for kind, model in (("rules", RuleInput), ("meals", MealInput), ("weights", WeightInput),
                        ("steps", StepsInput), ("recommendations", RecommendationInput)):
        add_crud(kind, model)

    @router.post("/recommendations/{identifier}/feedback", status_code=201)
    def feedback(identifier: str, body: FeedbackInput):
        return service.feedback(identifier, body.model_dump())

    return router
