trigger OrderWhatsAppTrigger on Order (after insert, before update, after update) {

    // BEFORE UPDATE: stamp the allocation date the first time a vehicle is assigned (drives #6 urgency).
    if (Trigger.isBefore && Trigger.isUpdate) {
        for (Order o : Trigger.new) {
            Order old = Trigger.oldMap.get(o.Id);
            if (o.Assigned_Vehicle__c != old.Assigned_Vehicle__c && o.Assigned_Vehicle__c != null
                && o.Allocation_Date__c == null) {
                o.Allocation_Date__c = Date.today();
            }
        }
        return;
    }

    // AFTER INSERT / AFTER UPDATE: outbound messages + manager alerts.
    List<WAStageMessenger.Item> items = new List<WAStageMessenger.Item>();
    List<Order> cancelled = new List<Order>();
    List<Order> vna = new List<Order>();

    if (Trigger.isInsert) {
        for (Order o : Trigger.new) {
            if (o.Phone__c != null) {
                items.add(new WAStageMessenger.Item(o.Id, 'Order', 'Created'));
            }
        }
    } else if (Trigger.isUpdate) {
        for (Order o : Trigger.new) {
            Order old = Trigger.oldMap.get(o.Id);
            // Status milestones (booking confirmed / ready / delivered / cancelled / etc.)
            if (o.Status != old.Status && o.Status != null && o.Phone__c != null) {
                items.add(new WAStageMessenger.Item(o.Id, 'Order', o.Status));
            }
            // Allocation: a specific vehicle gets assigned to the order.
            if (o.Assigned_Vehicle__c != old.Assigned_Vehicle__c && o.Assigned_Vehicle__c != null
                && o.Phone__c != null) {
                items.add(new WAStageMessenger.Item(o.Id, 'Order', 'Allocated'));
            }
            // #11 — cancellation -> manager callback Task.
            if (o.Status != old.Status && o.Status == 'Order Cancelled') {
                cancelled.add(o);
            }
            // #12 — VNA (vehicle not available / back-order) -> nearest-match manager alert.
            Boolean vorNow = (o.IsVOR__c && !old.IsVOR__c) || (o.IsBackOrder__c && !old.IsBackOrder__c);
            if (vorNow || (o.Status != old.Status && o.Status == 'Back Order')) {
                vna.add(o);
            }
        }
    }

    WAStageMessenger.send(items);
    if (!cancelled.isEmpty()) WAOrderAlerts.cancellationCallbacks(cancelled);
    if (!vna.isEmpty()) WAOrderAlerts.vnaAlerts(vna);
}
