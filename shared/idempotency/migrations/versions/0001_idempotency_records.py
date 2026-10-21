"""Create service-owned idempotency records.

Run in each owning service's migration context with its own search_path. This is
an independent Alembic branch; services with SQL migration runners use the same
metadata in their versioned migration step instead.
"""
from alembic import op
from shared.idempotency.models import metadata

revision = 'idem_0001'
down_revision = None
branch_labels = ('idempotency',)
depends_on = None


def upgrade():
    metadata.create_all(op.get_bind(), checkfirst=True)


def downgrade():
    raise RuntimeError('Idempotency tombstones prevent duplicate payments; destructive downgrade requires a reviewed data migration')
