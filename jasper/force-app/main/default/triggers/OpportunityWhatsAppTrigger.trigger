trigger OpportunityWhatsAppTrigger on Opportunity (after insert, after update) {
    List<WAStageMessenger.Item> items = new List<WAStageMessenger.Item>();
    if (Trigger.isInsert) {
        // New opportunity (lead showed booking intent / converted) -> greeting.
        for (Opportunity o : Trigger.new) {
            items.add(new WAStageMessenger.Item(o.Id, 'Opportunity', 'Created'));
        }
    } else if (Trigger.isUpdate) {
        // Opportunity lost -> lost/feedback message.
        for (Opportunity o : Trigger.new) {
            Opportunity old = Trigger.oldMap.get(o.Id);
            if (o.StageName != old.StageName && o.StageName == 'Closed Lost') {
                items.add(new WAStageMessenger.Item(o.Id, 'Opportunity', 'Closed Lost'));
            }
        }
    }
    WAStageMessenger.send(items);
}
