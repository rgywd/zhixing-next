"""Authenticated service surface for editable persona and personal follow-through."""

from fastapi import APIRouter
from pydantic import Field

from .growth import GrowthService
from .growth_schema import GoalPatch, PreferencesPatch
from .heartbeat import HeartbeatService
from .schemas import Input


class PersonaChange(Input):
    content: str = Field(max_length=4000)
    reason: str = Field(min_length=1, max_length=1000)
    expected_revision: int | None = Field(default=None, ge=0)
    memory_refs: dict[str, str] | None = None


class SkillChange(PersonaChange):
    pass


class GoalCreate(GoalPatch):
    id: str = Field(min_length=1, max_length=100)
    conversation_id: str = Field(min_length=1, max_length=100)


class PreferencesChange(PreferencesPatch):
    conversation_id: str | None = None


def create_router(store):
    router = APIRouter(prefix='/growth')
    service = GrowthService(store)

    @router.get('')
    def state():
        return service.read_state()

    @router.patch('/preferences')
    def preferences(body: PreferencesChange):
        return service.patch_preferences(body.model_dump(exclude_unset=True, exclude={'conversation_id'}),
                                         conversation_id=body.conversation_id)

    @router.put('/persona')
    def persona(body: PersonaChange):
        return service.update_persona(**body.model_dump())

    @router.put('/skills/{key}')
    def skill(key: str, body: SkillChange):
        return service.save_skill(key, **body.model_dump())

    @router.delete('/skills/{key}')
    def remove_skill(key: str, expected_revision: int | None = None):
        return service.delete_skill(key, expected_revision=expected_revision)

    @router.post('/goals')
    def create_goal(body: GoalCreate):
        return service.save_goal(body.model_dump(exclude_unset=True, exclude={'id', 'conversation_id'}),
                                 id=body.id, conversation_id=body.conversation_id)

    @router.patch('/goals/{goal_id}')
    def goal(goal_id: str, body: GoalPatch):
        return service.save_goal(body.model_dump(exclude_unset=True), id=goal_id)

    @router.get('/heartbeat')
    def heartbeat():
        return HeartbeatService(store).status()

    return router
