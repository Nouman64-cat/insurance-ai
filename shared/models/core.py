from datetime import date, datetime
from enum import Enum
from typing import List, Optional
from uuid import UUID, uuid4

from sqlalchemy import Column, Integer, JSON, String, Text, UniqueConstraint
from sqlmodel import Field, Relationship, SQLModel


# ─────────────────────────────────────────────────────────────────────────────
# Domain enumerations
# ─────────────────────────────────────────────────────────────────────────────

class Gender(str, Enum):
    MALE = "Male"
    FEMALE = "Female"
    OTHER = "Other"


class AIDecision(str, Enum):
    AUTO_APPROVE = "Auto Approve"
    APPROVE_WITH_LOADING = "Approve with Loading"
    HUMAN_REVIEW = "Human Review"
    DECLINE = "Decline"


# ─────────────────────────────────────────────────────────────────────────────
# Tenant  —  top-level isolation boundary
# ─────────────────────────────────────────────────────────────────────────────

class Tenant(SQLModel, table=True):
    """
    One row per insurance company / distribution partner using the platform.
    Every other table carries a tenant_id FK so queries can be scoped per tenant.
    """
    __tablename__ = "tenants"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(unique=True, index=True, max_length=255)
    is_active: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    applicants: List["Applicant"] = Relationship(back_populates="tenant")
    policies: List["Policy"] = Relationship(back_populates="tenant")
    risk_assessments: List["RiskAssessment"] = Relationship(back_populates="tenant")
    claims: List["Claim"] = Relationship(back_populates="tenant")
    artifacts: List["Artifact"] = Relationship(back_populates="tenant")
    commissions: List["Commission"] = Relationship(back_populates="tenant")
    users: List["User"] = Relationship(back_populates="tenant")


# ─────────────────────────────────────────────────────────────────────────────
# Role  —  RBAC role definitions (seeded once at startup)
# ─────────────────────────────────────────────────────────────────────────────

class Role(SQLModel, table=True):
    __tablename__ = "roles"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    name: str = Field(unique=True, index=True, max_length=100)
    description: str = Field(default="", max_length=500)

    users: List["User"] = Relationship(back_populates="role")


# ─────────────────────────────────────────────────────────────────────────────
# UserStatus & UserType
# ─────────────────────────────────────────────────────────────────────────────

class UserStatus(str, Enum):
    ACTIVE = "ACTIVE"
    INACTIVE = "INACTIVE"
    SUSPENDED = "SUSPENDED"
    LOCKED = "LOCKED"


class UserType(SQLModel, table=True):
    __tablename__ = "user_types"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    type_name: str = Field(unique=True, index=True, max_length=100)
    description: str = Field(default="", max_length=500)
    is_active: bool = Field(default=True, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    users: List["User"] = Relationship(back_populates="user_type")


# ─────────────────────────────────────────────────────────────────────────────
# User  —  an employee (underwriter / agent / admin) belonging to a Tenant
# ─────────────────────────────────────────────────────────────────────────────

class User(SQLModel, table=True):
    __tablename__ = "users"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    role_id: UUID = Field(foreign_key="roles.id", nullable=False)
    user_type_id: Optional[UUID] = Field(default=None, foreign_key="user_types.id", nullable=True)

    email: str = Field(unique=True, index=True, max_length=255)
    username: str = Field(unique=True, index=True, max_length=255)
    hashed_password: str = Field(max_length=255)
    full_name: str = Field(max_length=255)
    status: UserStatus = Field(default=UserStatus.ACTIVE, max_length=50, nullable=False)
    is_active: bool = Field(default=True, nullable=False)
    is_verified: bool = Field(default=False, nullable=False)
    failed_login_count: int = Field(default=0, nullable=False)
    last_login: Optional[datetime] = Field(default=None, nullable=True)
    is_deleted: bool = Field(default=False, nullable=False)
    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    tenant: Optional[Tenant] = Relationship(back_populates="users")
    role: Optional[Role] = Relationship(back_populates="users")
    user_type: Optional[UserType] = Relationship(back_populates="users")
    profile: Optional["UserProfile"] = Relationship(back_populates="user", sa_relationship_kwargs={"uselist": False, "cascade": "all, delete-orphan"})


# ─────────────────────────────────────────────────────────────────────────────
# UserProfile  —  detailed profile information for a User
# ─────────────────────────────────────────────────────────────────────────────

class UserProfile(SQLModel, table=True):
    __tablename__ = "user_profiles"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    user_id: UUID = Field(foreign_key="users.id", index=True, unique=True, nullable=False)

    first_name: str = Field(max_length=255)
    last_name: str = Field(max_length=255)
    phone: Optional[str] = Field(default=None, max_length=50, nullable=True)
    avatar_url: Optional[str] = Field(default=None, max_length=500, nullable=True)
    department: Optional[str] = Field(default=None, max_length=255, nullable=True)
    employee_id: Optional[str] = Field(default=None, max_length=100, nullable=True)
    designation: Optional[str] = Field(default=None, max_length=255, nullable=True)
    date_of_joining: Optional[date] = Field(default=None, nullable=True)
    updated_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    user: Optional[User] = Relationship(back_populates="profile")


# ─────────────────────────────────────────────────────────────────────────────
# Applicant  —  the person applying for a policy
# ─────────────────────────────────────────────────────────────────────────────

class Applicant(SQLModel, table=True):
    """
    Personal and financial profile of an insurance applicant.
    CNIC is unique per tenant (same person cannot have two records within one insurer).
    """
    __tablename__ = "applicants"
    __table_args__ = (
        UniqueConstraint("tenant_id", "cnic", name="uq_applicant_cnic_per_tenant"),
    )

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)

    # Identity
    cnic: str = Field(index=True, max_length=15)        # Pakistani National Identity Card
    name: str = Field(max_length=255)
    dob: date
    gender: Gender

    # Socio-economic profile used by the risk engine
    occupation: str = Field(max_length=255)
    declared_income: float = Field(ge=0)
    details: Optional[dict] = Field(default=None, sa_column=Column(JSON, nullable=True))

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="applicants")
    policies: List["Policy"] = Relationship(back_populates="applicant")
    risk_assessments: List["RiskAssessment"] = Relationship(back_populates="applicant")
    artifacts: List["Artifact"] = Relationship(back_populates="applicant")


# ─────────────────────────────────────────────────────────────────────────────
# Policy  —  the insurance product being applied for
# ─────────────────────────────────────────────────────────────────────────────

class Policy(SQLModel, table=True):
    """
    A requested insurance policy linked to a specific applicant and tenant.
    Coverage details drive the risk-engine scoring logic.
    """
    __tablename__ = "policies"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    applicant_id: UUID = Field(foreign_key="applicants.id", index=True, nullable=False)

    product_name: str = Field(max_length=255)           # e.g. "Term Life", "Health Platinum"
    coverage_amount: float = Field(ge=0)                # in PKR
    term_years: int = Field(ge=1, le=40)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="policies")
    applicant: Optional[Applicant] = Relationship(back_populates="policies")
    claims: List["Claim"] = Relationship(back_populates="policy")
    commission: Optional["Commission"] = Relationship(back_populates="policy")


# ─────────────────────────────────────────────────────────────────────────────
# RiskAssessment  —  AI underwriting output for an applicant
# ─────────────────────────────────────────────────────────────────────────────

class RiskAssessment(SQLModel, table=True):
    """
    Stores the output produced by the risk-engine and decision-engine for a
    given applicant. One applicant may have multiple assessments over time
    (re-assessment after additional information, appeals, etc.).
    """
    __tablename__ = "risk_assessments"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    applicant_id: UUID = Field(foreign_key="applicants.id", index=True, nullable=False)

    # Scoring  (0–100 for medical/financial; 0.0–1.0 for fraud probability)
    medical_score: int = Field(ge=0, le=100)
    financial_score: int = Field(ge=0, le=100)
    fraud_probability: float = Field(ge=0.0, le=1.0)

    # Decision output
    ai_decision: AIDecision
    # Premium loading percentage (e.g. 25.0 means +25% on base premium)
    suggested_loading: Optional[float] = Field(default=None, ge=0.0, le=500.0)

    # Explainable-AI reasons — stored as a JSON array of human-readable strings
    # e.g. ["BMI above threshold", "High-risk occupation", "Income–coverage ratio 8x"]
    reasons: Optional[List[str]] = Field(
        default=None,
        sa_column=Column(JSON, nullable=True),
    )

    # Composite weighted score (0–100) computed by the risk engine aggregation node
    composite_risk_score: Optional[int] = Field(default=None, ge=0, le=100)

    # Case linkage — optional since Live Evaluation has no case context
    case_id: Optional[UUID] = Field(default=None, foreign_key="cases.caseld", nullable=True)

    # AI case summary generated by the text-summarizer before evaluation
    ai_summary: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="risk_assessments")
    applicant: Optional[Applicant] = Relationship(back_populates="risk_assessments")


# ─────────────────────────────────────────────────────────────────────────────
# Claim  —  a benefit claim filed against an active policy
# ─────────────────────────────────────────────────────────────────────────────

class Claim(SQLModel, table=True):
    __tablename__ = "claims"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    claim_type: str = Field(max_length=100)         # e.g. 'Hospitalization', 'Death', 'Reimbursement'
    submitted_amount: float = Field(ge=0)
    approved_amount: float = Field(default=0, ge=0)
    status: str = Field(max_length=50)              # e.g. 'Approved', 'Rejected', 'Investigation'
    fraud_probability: float = Field(ge=0.0, le=1.0)
    duplicate_flag: bool = Field(default=False)
    ai_recommendation: str = Field(max_length=500)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    tenant: Optional[Tenant] = Relationship(back_populates="claims")
    policy: Optional[Policy] = Relationship(back_populates="claims")
    artifacts: List["Artifact"] = Relationship(back_populates="claim")


# ─────────────────────────────────────────────────────────────────────────────
# Artifact  —  a document attached to an applicant or a claim
# Defined after Claim because claim_id is a FK to claims.
# ─────────────────────────────────────────────────────────────────────────────

class Artifact(SQLModel, table=True):
    __tablename__ = "artifacts"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    applicant_id: Optional[UUID] = Field(default=None, foreign_key="applicants.id", index=True)
    claim_id: Optional[UUID] = Field(default=None, foreign_key="claims.id", index=True)
    case_id: Optional[UUID] = Field(default=None, foreign_key="cases.caseld", index=True)
    uploaded_by: Optional[UUID] = Field(default=None, foreign_key="users.id", index=True)

    document_type: str = Field(max_length=100)
    file_name: Optional[str] = Field(default=None, sa_column=Column(String(255), nullable=True))
    file_size: Optional[int] = Field(default=None, sa_column=Column(Integer, nullable=True))
    file_type: Optional[str] = Field(default=None, sa_column=Column(String(100), nullable=True))
    storage_url: Optional[str] = Field(default=None, sa_column=Column(String(1000), nullable=True))
    ocr_result: Optional[str] = Field(default=None, sa_column=Column(Text, nullable=True))
    ocr_confidence_score: float = Field(default=0.0, ge=0.0, le=1.0)
    authenticity_score: float = Field(default=1.0, ge=0.0, le=1.0)
    quality_score: float = Field(default=1.0, ge=0.0, le=1.0)
    tampered_flag: bool = Field(default=False)
    status: str = Field(default="Processing", max_length=50)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    tenant: Optional[Tenant] = Relationship(back_populates="artifacts")
    applicant: Optional[Applicant] = Relationship(back_populates="artifacts")
    claim: Optional[Claim] = Relationship(back_populates="artifacts")


# ─────────────────────────────────────────────────────────────────────────────
# Commission  —  agent commission record for a sold policy
# ─────────────────────────────────────────────────────────────────────────────

class Commission(SQLModel, table=True):
    __tablename__ = "commissions"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True, nullable=False)
    policy_id: UUID = Field(foreign_key="policies.id", index=True, nullable=False)

    agent_id: str = Field(index=True, max_length=100)
    overall_ai_score: float = Field(ge=0.0, le=100.0)
    commission_percentage: float = Field(ge=0.0, le=100.0)
    calculated_amount: float = Field(ge=0)
    bonus_eligible: bool = Field(default=False)

    created_at: datetime = Field(default_factory=datetime.utcnow, nullable=False)

    # Relationships
    # Policy.commission is Optional[Commission] (not a list) → SQLModel sets uselist=False.
    tenant: Optional[Tenant] = Relationship(back_populates="commissions")
    policy: Optional[Policy] = Relationship(back_populates="commission")


# ─────────────────────────────────────────────────────────────────────────────
# Case Management Enums
# ─────────────────────────────────────────────────────────────────────────────

class CaseTypeEnum(str, Enum):
    UNDERWRITING = "Underwriting"
    CLAIM = "Claim"
    INQUIRY = "Inquiry"

class CaseStatusEnum(str, Enum):
    NEW = "New"
    IN_PROGRESS = "InProgress"
    PENDING_DOCUMENTS = "Pending Documents"
    UNDER_REVIEW = "Under Review"
    APPROVED = "Approved"
    REJECTED = "Rejected"
    CLOSED = "Closed"

class CasePriorityEnum(str, Enum):
    LOW = "Low"
    NORMAL = "Normal"
    HIGH = "High"
    CRITICAL = "Critical"

class SourceChannelEnum(str, Enum):
    AGENT = "Agent"
    BANCASSURANCE = "Bancassurance"
    ONLINE = "Online"
    BRANCH = "Branch"
    MOBILE = "Mobile"

class StatusCategoryEnum(str, Enum):
    OPEN = "Open"
    ACTIVE = "Active"
    PENDING = "Pending"
    TERMINAL = "Terminal"

class WorkflowStateEnum(str, Enum):
    RUNNING = "Running"
    PAUSED = "Paused"
    COMPLETED = "Completed"
    FAILED = "Failed"

class AssignedRoleEnum(str, Enum):
    UNDERWRITER = "Underwriter"
    ANALYST = "Analyst"
    MANAGER = "Manager"
    COORDINATOR = "Coordinator"
    REVIEWER = "Reviewer"

class AssignmentTypeEnum(str, Enum):
    PRIMARY = "Primary"
    SECONDARY = "Secondary"
    ESCALATION = "Escalation"
    TEMPORARY = "Temporary"

class AssignmentStatusEnum(str, Enum):
    ACTIVE = "Active"
    COMPLETED = "Completed"
    TRANSFERRED = "Transferred"
    REVOKED = "Revoked"

class ActionTypeEnum(str, Enum):
    STATUS_CHANGE = "StatusChange"
    ASSIGNMENT = "Assignment"
    COMMENT = "Comment"
    ESCALATION = "Escalation"
    DOCUMENT_UPLOAD = "DocumentUpload"
    DECISION = "Decision"

class ResolutionStatusEnum(str, Enum):
    OPEN = "Open"
    RESOLVED = "Resolved"
    PENDING = "Pending"
    CLOSED = "Closed"

class CommentTypeEnum(str, Enum):
    INTERNAL = "Internal"
    EXTERNAL = "External"

class VisibilityLevelEnum(str, Enum):
    PRIVATE = "Private"
    TEAM = "Team"
    ALL = "All"

class DocumentClassificationEnum(str, Enum):
    MEDICAL = "Medical"
    FINANCIAL = "Financial"
    IDENTITY = "Identity"
    LEGAL = "Legal"
    OTHER = "Other"


# ─────────────────────────────────────────────────────────────────────────────
# 1. Case
# ─────────────────────────────────────────────────────────────────────────────
class Case(SQLModel, table=True):
    __tablename__ = "cases"

    caseld: UUID = Field(default_factory=uuid4, primary_key=True)
    tenant_id: UUID = Field(foreign_key="tenants.id", index=True)
    applicant_id: UUID = Field(foreign_key="applicants.id", index=True)
    caseNumber: str = Field(index=True, unique=True, max_length=50)
    caseType: CaseTypeEnum = Field(max_length=50)
    caseStatus: CaseStatusEnum = Field(default=CaseStatusEnum.NEW, max_length=50)
    priorityLevel: CasePriorityEnum = Field(default=CasePriorityEnum.NORMAL, max_length=50)
    sourceChannel: SourceChannelEnum = Field(max_length=50)
    createdAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    updatedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    assignedTeamld: Optional[UUID] = Field(default=None, nullable=True)
    assignedAgentId: Optional[UUID] = Field(default=None, foreign_key="users.id", nullable=True)
    slaDeadline: Optional[datetime] = Field(default=None, nullable=True)
    escalationLevel: int = Field(default=0)
    parentCaseld: Optional[UUID] = Field(default=None, foreign_key="cases.caseld", nullable=True)

    # Relationships
    workflows: List["CaseWorkflow"] = Relationship(back_populates="case")
    assignments: List["CaseAssignment"] = Relationship(back_populates="case")
    history: List["CaseHistory"] = Relationship(back_populates="case")
    escalations: List["CaseEscalation"] = Relationship(back_populates="case")
    comments: List["CaseComment"] = Relationship(back_populates="case")
    attachments: List["CaseAttachment"] = Relationship(back_populates="case")


# ─────────────────────────────────────────────────────────────────────────────
# 2. CaseStatus
# ─────────────────────────────────────────────────────────────────────────────
class CaseStatus(SQLModel, table=True):
    __tablename__ = "case_statuses"

    statusld: UUID = Field(default_factory=uuid4, primary_key=True)
    statusName: CaseStatusEnum = Field(max_length=50, unique=True)
    statusCategory: StatusCategoryEnum = Field(max_length=50)
    isFinalStatus: bool = Field(default=False)
    description: Optional[str] = Field(default=None, nullable=True)


# ─────────────────────────────────────────────────────────────────────────────
# 3. CaseWorkflow
# ─────────────────────────────────────────────────────────────────────────────
class CaseWorkflow(SQLModel, table=True):
    __tablename__ = "case_workflows"

    workflowid: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    currentStep: str = Field(max_length=100)
    previousStep: Optional[str] = Field(default=None, max_length=100, nullable=True)
    workflowState: WorkflowStateEnum = Field(max_length=50)
    triggeredBy: Optional[UUID] = Field(default=None, nullable=True)
    lastUpdatedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    workflowVersion: str = Field(max_length=20)

    case: Optional[Case] = Relationship(back_populates="workflows")


# ─────────────────────────────────────────────────────────────────────────────
# 4. CaseAssignment
# ─────────────────────────────────────────────────────────────────────────────
class CaseAssignment(SQLModel, table=True):
    __tablename__ = "case_assignments"

    assignmentld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    assignedToUserld: UUID = Field(foreign_key="users.id", index=True)
    assignedRole: AssignedRoleEnum = Field(max_length=50)
    assignmentType: AssignmentTypeEnum = Field(max_length=50)
    assignedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    workloadPercentage: float = Field(default=100.0)
    assignmentStatus: AssignmentStatusEnum = Field(default=AssignmentStatusEnum.ACTIVE, max_length=50)

    case: Optional[Case] = Relationship(back_populates="assignments")


# ─────────────────────────────────────────────────────────────────────────────
# 5. CaseHistory
# ─────────────────────────────────────────────────────────────────────────────
class CaseHistory(SQLModel, table=True):
    __tablename__ = "case_histories"

    historyld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    actionType: ActionTypeEnum = Field(max_length=50)
    fromStatus: Optional[str] = Field(default=None, max_length=50, nullable=True)
    toStatus: Optional[str] = Field(default=None, max_length=50, nullable=True)
    changedBy: UUID = Field(foreign_key="users.id", index=True)
    changeTimestamp: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    systemGeneratedFlag: bool = Field(default=False)

    case: Optional[Case] = Relationship(back_populates="history")


# ─────────────────────────────────────────────────────────────────────────────
# 6. CasePriority
# ─────────────────────────────────────────────────────────────────────────────
class CasePriority(SQLModel, table=True):
    __tablename__ = "case_priorities"

    priorityld: UUID = Field(default_factory=uuid4, primary_key=True)
    priorityLevel: CasePriorityEnum = Field(max_length=50, unique=True)
    priorityScore: int = Field()
    escalationRuleld: Optional[UUID] = Field(default=None, nullable=True)


# ─────────────────────────────────────────────────────────────────────────────
# 7. CaseEscalation
# ─────────────────────────────────────────────────────────────────────────────
class CaseEscalation(SQLModel, table=True):
    __tablename__ = "case_escalations"

    escalationld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    escalationLevel: int = Field()
    escalationReason: str = Field(nullable=False)
    escalatedTo: UUID = Field(foreign_key="users.id", index=True)
    escalationTimestamp: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    resolutionStatus: ResolutionStatusEnum = Field(default=ResolutionStatusEnum.OPEN, max_length=50)

    case: Optional[Case] = Relationship(back_populates="escalations")


# ─────────────────────────────────────────────────────────────────────────────
# 8. CaseComment
# ─────────────────────────────────────────────────────────────────────────────
class CaseComment(SQLModel, table=True):
    __tablename__ = "case_comments"

    commentld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    authorld: UUID = Field(foreign_key="users.id", index=True)
    commentText: str = Field(nullable=False)
    commentType: CommentTypeEnum = Field(max_length=50)
    createdAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    visibilityLevel: VisibilityLevelEnum = Field(max_length=50)

    case: Optional[Case] = Relationship(back_populates="comments")


# ─────────────────────────────────────────────────────────────────────────────
# 9. CaseAttachment
# ─────────────────────────────────────────────────────────────────────────────
class CaseAttachment(SQLModel, table=True):
    __tablename__ = "case_attachments"

    attachmentid: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(foreign_key="cases.caseld", index=True)
    fileName: str = Field(max_length=255)
    fileType: str = Field(max_length=50)
    fileSize: Optional[int] = Field(default=None, nullable=True)
    storageUrl: str = Field(max_length=500)
    uploadedBy: UUID = Field(foreign_key="users.id", index=True)
    uploadedAt: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    documentClassification: DocumentClassificationEnum = Field(max_length=50)

    case: Optional[Case] = Relationship(back_populates="attachments")


# ─────────────────────────────────────────────────────────────────────────────
# 10. CaseAuditTrail
# ─────────────────────────────────────────────────────────────────────────────
class CaseAuditTrail(SQLModel, table=True):
    __tablename__ = "case_audit_trails"

    auditld: UUID = Field(default_factory=uuid4, primary_key=True)
    caseld: UUID = Field(index=True)
    actionPerformed: str = Field(max_length=200)
    entityChanged: str = Field(max_length=100)
    previousValue: Optional[str] = Field(default=None, nullable=True)
    newValue: Optional[str] = Field(default=None, nullable=True)
    performedBy: UUID = Field(foreign_key="users.id", index=True)
    timestamp: datetime = Field(default_factory=datetime.utcnow, nullable=False)
    ipAddress: Optional[str] = Field(default=None, max_length=45, nullable=True)
