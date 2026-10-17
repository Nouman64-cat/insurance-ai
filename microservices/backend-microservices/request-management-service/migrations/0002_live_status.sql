-- Request Management: live status updates.
-- Every change to a request's status, assignment or version sends a small notice on the
-- request_management_changes channel. It's delivered only when the transaction commits, so listeners never see a
-- change that was rolled back. The notice carries ids and statuses only; app/live.py decides who may receive it.

SET search_path TO request_management;

CREATE FUNCTION notify_request_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify('request_management_changes', json_build_object(
        'tenant_id', NEW.tenant_id, 'request_id', NEW.id, 'version', NEW.version,
        'review_status', NEW.review_status, 'execution_status', NEW.execution_status)::text);
    RETURN NULL;
END $$;

CREATE TRIGGER trg_requests_notify AFTER INSERT OR UPDATE OF review_status, execution_status, assignee_user_id, queue_role, version
    ON requests FOR EACH ROW EXECUTE FUNCTION notify_request_change();
