"""Editable document templates (Proposal, Illustration per acquisition source). Content format and rules: shared/doc_templates.py.

A template has ONE editable draft at a time and any number of published versions. A published version never changes (trigger in
shared/evaluation/ddl.py): publishing a draft makes it the next version and marks the previous one superseded.
"""
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import CheckConstraint, Column, Index, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

TEMPLATE_KINDS = ("proposal", "illustration")
TEMPLATE_VERSION_STATES = ("draft", "published", "superseded")


class DocumentTemplate(SQLModel, table=True):
    __tablename__ = "document_templates"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    template_key: str = Field(unique=True, index=True, max_length=80)        # proposal, illustration:agent, ...
    kind: str = Field(index=True, max_length=20)
    group_key: Optional[str] = Field(default=None, max_length=40)            # the acquisition source type, for an illustration
    title: str = Field(max_length=200)
    description: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    status: str = Field(default="active", max_length=12)
    created_at: datetime = Field(default_factory=datetime.utcnow)


class DocumentTemplateVersion(SQLModel, table=True):
    __tablename__ = "document_template_versions"
    __table_args__ = (
        UniqueConstraint("template_id", "version", name="uq_document_template_version"),
        CheckConstraint("state IN ('draft','published','superseded')", name="ck_document_template_state"),
        CheckConstraint("state = 'draft' OR (published_by IS NOT NULL AND published_at IS NOT NULL AND length(btrim(coalesce(change_note, ''))) > 0)",
                        name="ck_document_template_published_needs_person_and_note"),
        Index("uq_document_template_one_draft", "template_id", unique=True, postgresql_where=text("state = 'draft'")),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    template_id: UUID = Field(foreign_key="document_templates.id", index=True)
    version: int
    state: str = Field(default="draft", max_length=12)
    content: dict = Field(sa_column=Column(JSONB, nullable=False))
    content_sha256: str = Field(max_length=64)
    change_note: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    created_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    published_by: Optional[UUID] = Field(default=None, foreign_key="users.id")
    published_at: Optional[datetime] = None
