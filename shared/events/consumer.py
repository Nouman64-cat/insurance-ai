"""Manual offset handling that cannot commit beyond a failed message."""
import logging

log = logging.getLogger('business.consumer')


async def process_partition(consumer, partition, messages, process):
    """Process in partition order; commit only the successfully handled offset.

    On failure, rewind this partition and stop its batch. Committing the consumer's
    global position could acknowledge later fetched messages that never succeeded.
    Handler results must be durable before returning. Cancellation propagates.
    """
    for message in messages:
        try:
            await process(message)
            await consumer.commit({partition: message.offset + 1})
        except Exception as exc:
            consumer.seek(partition, message.offset)
            log.warning('message_retry partition=%s offset=%s error_type=%s',
                        partition, message.offset, type(exc).__name__)
            return False
    return True
