public with sharing class WAVars {
    /**
     * Maps a template name to the ordered list of data keys that fill its body
     * variables {{1}}, {{2}}, ... Keys are looked up in the per-recipient data map.
     */
    public static final Map<String, List<String>> TEMPLATE_VARS = new Map<String, List<String>>{
        'jasper_booking_confirmed' => new List<String>{ 'name', 'vehicle', 'variant', 'color', 'orderNumber', 'amount', 'edd' },
        'jasper_delivery_ready' => new List<String>{ 'name', 'vehicle', 'orderNumber' },
        'jasper_lead_lost' => new List<String>{ 'name', 'lostReason' },
        'jasper_opportunity_greeting' => new List<String>{ 'name' },
        'jasper_pending_followup' => new List<String>{ 'name' },
        'jasper_delivered_congrats' => new List<String>{ 'name', 'vehicle', 'orderNumber' },
        'jasper_birthday_greeting' => new List<String>{ 'name' },
        'jasper_anniversary_greeting' => new List<String>{ 'name' },
        'jasper_price_alert' => new List<String>{ 'name', 'vehicle', 'price' },
        'jasper_platinum_spotlight' => new List<String>{ 'name', 'vehicle', 'price' },
        'jasper_allocation_alert' => new List<String>{ 'name', 'vehicle', 'orderNumber', 'edd' },
        'jasper_payment_alert' => new List<String>{ 'name', 'remaining', 'vehicle', 'orderNumber' },
        'jasper_cancellation_survey' => new List<String>{ 'name', 'vehicle', 'orderNumber' },
        'jasper_retail_urgency' => new List<String>{ 'name', 'vehicle', 'orderNumber' }
    };

    /**
     * Templates that have a dynamic URL button -> the data key holding the dynamic suffix
     * (e.g. a record id appended to the button's base URL ".../page?id={{1}}").
     */
    public static final Map<String, String> BUTTON_URL_VARS = new Map<String, String>{
        'jasper_delivered_congrats' => 'surveyId'
    };

    /**
     * Returns the URL-button send component (sub_type=url, index 0) for a template that has
     * a dynamic URL button, or null. The parameter is the dynamic suffix (e.g. a Lead id).
     */
    public static Map<String, Object> urlButtonComponent(String templateName, Map<String, String> data) {
        String key = BUTTON_URL_VARS.get(templateName);
        if (key == null) return null;
        String v = (data != null && data.containsKey(key)) ? data.get(key) : null;
        if (String.isBlank(v)) return null;
        return new Map<String, Object>{
            'type' => 'button',
            'sub_type' => 'url',
            'index' => 0,
            'parameters' => new List<Object>{ new Map<String, Object>{ 'type' => 'text', 'text' => v } }
        };
    }

    /**
     * Build the WhatsApp body parameters for a template from a data map.
     * Falls back to ['name'] for unmapped templates that still have a variable.
     * Returns null when no body variables are needed.
     */
    public static List<Object> bodyParams(String templateName, Map<String, String> data, Boolean hasBodyVar) {
        List<String> keys = TEMPLATE_VARS.get(templateName);
        if (keys == null) {
            if (hasBodyVar == true) {
                keys = new List<String>{ 'name' };
            } else {
                return null;
            }
        }
        List<Object> params = new List<Object>();
        for (String k : keys) {
            String v = (data != null && data.containsKey(k) && data.get(k) != null) ? data.get(k) : '';
            // WhatsApp rejects empty params; use a sensible placeholder.
            if (String.isBlank(v)) v = (k == 'name') ? 'there' : '-';
            params.add(new Map<String, Object>{ 'type' => 'text', 'text' => v });
        }
        return params;
    }
}
