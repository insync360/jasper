/**
 * Daily scheduled job that sends WhatsApp greetings on customers' important days.
 * Run once a day (see System.schedule below); it finds everyone whose birthday or
 * anniversary is *today* (Leads + Contacts) and enqueues a callout job to send the
 * matching approved template via the bot backend.
 *
 * Template names are read from the editable WA_Stage_Message__c config
 * (Object__c='Lead', Status_Value__c='Birthday'/'Anniversary'); if none is configured
 * the defaults jasper_birthday_greeting / jasper_anniversary_greeting are used.
 *
 * Schedule daily at 9 AM with:
 *   System.schedule('WA Daily Greetings', '0 0 9 * * ?', new WAGreetingScheduler());
 */
public with sharing class WAGreetingScheduler implements Schedulable {

    public void execute(SchedulableContext sc) {
        Date today = Date.today();
        Integer m = today.month();
        Integer d = today.day();

        String birthdayTpl = templateFor('Birthday', 'jasper_birthday_greeting');
        String anniversaryTpl = templateFor('Anniversary', 'jasper_anniversary_greeting');

        List<Recipient> recips = new List<Recipient>();

        // --- Birthdays: active Leads ---
        for (Lead l : [
            SELECT FirstName, Name, Phone FROM Lead
            WHERE Birth_Date__c != null
              AND CALENDAR_MONTH(Birth_Date__c) = :m
              AND DAY_IN_MONTH(Birth_Date__c) = :d
              AND IsConverted = false AND Phone != null
        ]) {
            recips.add(new Recipient(firstNameOf(l.FirstName, l.Name), l.Phone, birthdayTpl));
        }
        // --- Birthdays: Contacts (converted customers) ---
        for (Contact c : [
            SELECT FirstName, Name, Phone, MobilePhone FROM Contact
            WHERE Birthdate != null
              AND CALENDAR_MONTH(Birthdate) = :m
              AND DAY_IN_MONTH(Birthdate) = :d
              AND (Phone != null OR MobilePhone != null)
        ]) {
            String ph = String.isNotBlank(c.MobilePhone) ? c.MobilePhone : c.Phone;
            recips.add(new Recipient(firstNameOf(c.FirstName, c.Name), ph, birthdayTpl));
        }
        // --- Anniversaries: active Leads ---
        for (Lead l : [
            SELECT FirstName, Name, Phone FROM Lead
            WHERE Anniversary_Date__c != null
              AND CALENDAR_MONTH(Anniversary_Date__c) = :m
              AND DAY_IN_MONTH(Anniversary_Date__c) = :d
              AND IsConverted = false AND Phone != null
        ]) {
            recips.add(new Recipient(firstNameOf(l.FirstName, l.Name), l.Phone, anniversaryTpl));
        }

        // De-dupe by phone so a customer who exists as both a Lead and a Contact (same number)
        // gets only one greeting.
        List<Recipient> unique = new List<Recipient>();
        Set<String> seen = new Set<String>();
        for (Recipient r : recips) {
            String ph = normalize(r.phone);
            if (String.isBlank(ph) || seen.contains(ph)) continue;
            seen.add(ph);
            unique.add(r);
        }
        if (!unique.isEmpty()) System.enqueueJob(new Sender(unique));
    }

    /** Template name from editable config, or a default. */
    static String templateFor(String statusValue, String dflt) {
        for (WA_Stage_Message__c c : [
            SELECT Template_Name__c FROM WA_Stage_Message__c
            WHERE Object__c = 'Lead' AND Status_Value__c = :statusValue AND Active__c = true
            LIMIT 1
        ]) {
            if (String.isNotBlank(c.Template_Name__c)) return c.Template_Name__c;
        }
        return dflt;
    }

    static String firstNameOf(String fn, String full) {
        if (String.isNotBlank(fn)) return fn;
        if (String.isNotBlank(full)) return full.split(' ')[0];
        return 'there';
    }

    public class Recipient {
        public String name;
        public String phone;
        public String tpl;
        public Recipient(String n, String p, String t) {
            this.name = n; this.phone = p; this.tpl = t;
        }
    }

    /** Does the WhatsApp callouts (async, callout-enabled). */
    public class Sender implements Queueable, Database.AllowsCallouts {
        List<Recipient> recips;
        public Sender(List<Recipient> r) { this.recips = r; }

        public void execute(QueueableContext qc) {
            WA_Bot_Setting__c s = WA_Bot_Setting__c.getOrgDefaults();
            String base = (s == null || s.Base_URL__c == null) ? '' : s.Base_URL__c.removeEnd('/');
            for (Recipient r : recips) {
                String phone = normalize(r.phone);
                if (String.isBlank(phone) || String.isBlank(r.tpl)) continue;
                Map<String, String> data = new Map<String, String>{ 'name' => r.name };
                Map<String, Object> body = new Map<String, Object>{
                    'to' => phone,
                    'template' => r.tpl,
                    'language' => 'en',
                    'components' => new List<Object>{
                        new Map<String, Object>{ 'type' => 'body', 'parameters' => WAVars.bodyParams(r.tpl, data, true) }
                    }
                };
                try {
                    HttpRequest req = new HttpRequest();
                    req.setEndpoint(base + '/send/template');
                    req.setMethod('POST');
                    req.setHeader('Content-Type', 'application/json');
                    req.setTimeout(60000);
                    req.setBody(JSON.serialize(body));
                    new Http().send(req);
                } catch (Exception e) {
                    System.debug('WA greeting send failed: ' + e.getMessage());
                }
            }
        }
    }

    static String normalize(String p) {
        if (p == null) return '';
        String digits = p.replaceAll('[^0-9]', '');
        if (digits.length() == 10) digits = '91' + digits;
        return digits;
    }
}
