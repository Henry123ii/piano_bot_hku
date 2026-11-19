/* Shared, dependency-free helpers. All displayed booking times are Hong Kong time. */
(function (root) {
  "use strict";
  const BASE = "https://hkufbs.hku.hk/fbs/centralbook/book/Web/";
  const ROOMS = [
    {id: "2871", sid: "421", name: "FSCAC Music Room 108"},
    {id: "2873", sid: "421", name: "FSCAC Music Room 109"},
    {id: "2889", sid: "432", name: "CYMAC Music Room"}
  ];
  function hkParts(ms = Date.now()) {
    const d = new Date(ms + 8 * 3600000);
    return {date: d.toISOString().slice(0,10), time: d.toISOString().slice(11,19)};
  }
  function hkStamp(ms = Date.now()) {
    const p = hkParts(ms);
    return `${p.date} ${p.time}.${String(new Date(ms).getUTCMilliseconds()).padStart(3,"0")} HKT`;
  }
  function timeValue(s) {
    const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(s));
    if (!m || +m[1]>23 || +m[2]>59 || +(m[3]||0)>59) throw Error("Use a valid 24-hour time.");
    return `${m[1]}:${m[2]}:${m[3]||"00"}`;
  }
  function hkEpoch(date, time) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error("Choose a valid date.");
    const stamp = Date.parse(`${date}T${timeValue(time)}+08:00`);
    if (!Number.isFinite(stamp) || hkParts(stamp).date !== date) throw Error("Choose a real calendar date.");
    return stamp;
  }
  function addDays(date,days) {
    return hkParts(hkEpoch(date,"12:00")+days*86400000).date;
  }
  function endDate(c) {
    // Weekly 23:00-00:00 slots end on the following date, never one hour earlier.
    return c.endDate || (timeValue(c.end)<timeValue(c.start)?addDays(c.date,1):c.date);
  }
  const FORM_OPEN_LEAD_MS=60000;
  // Edition-wide fixed targets: user preferences never override these.
  const CREATE_AFTER_RELEASE_SECONDS=0.2;
  const CAPTCHA_BEFORE_RELEASE_SECONDS=10;
  const FIXED_CAPTCHA_WAIT_SECONDS=120;
  function timingSettings(c) {
    return {values:{offset:CREATE_AFTER_RELEASE_SECONDS,captchaLead:CAPTCHA_BEFORE_RELEASE_SECONDS,late:FIXED_CAPTCHA_WAIT_SECONDS},corrections:[]};
  }
  function reservationURL(c) {
    const room = ROOMS.find(r => r.id === c.roomId);
    if (!room) throw Error("Choose one of the configured rooms.");
    const u = new URL("reservation/", BASE);
    u.search = new URLSearchParams({rid:room.id, sid:room.sid, rd:c.date,
      sd:`${c.date} ${timeValue(c.start)}`, ed:`${endDate(c)} ${timeValue(c.end)}`}).toString();
    return u.href;
  }
  function parseReservationURL(value) {
    try {
      const u = new URL(value, BASE), p = u.searchParams;
      if (u.origin !== new URL(BASE).origin || !/\/reservation\/?$/.test(u.pathname)) return null;
      const room = ROOMS.find(r => r.id===p.get("rid") && r.sid===p.get("sid"));
      const sd = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(p.get("sd")||"");
      const ed = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/.exec(p.get("ed")||"");
      if (!room || !sd || !ed) return null;
      const duration=hkEpoch(ed[1],ed[2])-hkEpoch(sd[1],sd[2]);
      if(duration!==3600000 || !/^\d{2}:00:00$/.test(timeValue(sd[2])) || !/^\d{2}:00:00$/.test(timeValue(ed[2])))return null;
      return {roomId:room.id, date:sd[1], start:timeValue(sd[2]), end:timeValue(ed[2]),...(ed[1]!==sd[1]?{endDate:ed[1]}:{})};
    } catch { return null; }
  }
  function validate(c, now=Date.now()) {
    if (!ROOMS.some(r=>r.id===c.roomId)) throw Error("Select a room.");
    if (!String(c.uid||"").trim() || !String(c.phone||"").trim()) throw Error("Enter your student UID and contact number.");
    if(c.uid.length>64 || c.phone.length>40 || /[\r\n\t]/.test(c.uid+c.phone))throw Error("Check your UID and contact number; use one line of ordinary text.");
    if(c.agreementAccepted!==true)throw Error("Read and accept the booking agreement once. Your choice will be remembered on this device.");
    if (!Number.isInteger(+c.people) || +c.people<1 || +c.people>100) throw Error("Room users must be a whole number from 1 to 100.");
    const start=hkEpoch(c.date,c.start), end=hkEpoch(endDate(c),c.end);
    // HKU piano slots must be exactly one hour, beginning and ending on the hour.
    if (end-start!==3600000 || !/^\d{2}:00:00$/.test(timeValue(c.start)) || !/^\d{2}:00:00$/.test(timeValue(c.end)))
      throw Error("Choose exactly one full clock hour (for example, 14:00-15:00). Half-hour starts and multi-hour bookings are not supported.");
    if (start<=now) throw Error("The requested room session has already started. Choose a future session.");
    if (+c.offset !== CREATE_AFTER_RELEASE_SECONDS || +c.captchaLead !== CAPTCHA_BEFORE_RELEASE_SECONDS)
      throw Error("This edition uses fixed internal submission and CAPTCHA timing.");
    if (+c.late !== FIXED_CAPTCHA_WAIT_SECONDS)
      throw Error("This edition uses a fixed internal CAPTCHA verification window.");
    if (c.mode!=="scheduled" && c.mode!=="now") throw Error("Choose a run mode.");
    if (c.mode==="scheduled") {
      const release = hkEpoch(c.releaseDate,c.releaseTime);
      // A past release is handled explicitly at review, not silently rolled to tomorrow.
      if(release>now+366*86400000)throw Error("The release date is more than a year away. Check the year.");
      if (release + CREATE_AFTER_RELEASE_SECONDS*1000 >= start) throw Error("Submission must be before the room booking starts.");
    }
    return true;
  }
  function plan(c, now=Date.now()) {
    const release = c.mode==="now" ? now : hkEpoch(c.releaseDate,c.releaseTime);
    // All three timestamps derive from the same slot-release instant.
    return {release, openAt:c.mode==="now"?now:release-FORM_OPEN_LEAD_MS,
      clickAt:release+Math.round(CREATE_AFTER_RELEASE_SECONDS*1000),
      captchaAt:c.mode==="now"?now:release-Math.round(CAPTCHA_BEFORE_RELEASE_SECONDS*1000)};
  }
  function classify(text) {
    // Only classify the response text, never the entire booking page.
    const t=String(text||"");
    if (/\b(?:failed|failure|error|conflict|unavailable|already booked|could not be made|not permitted|not allowed|invalid|expired)\b/i.test(t)) return "rejected";
    if (/\b(?:pending approval|requires approval|awaiting approval)\b/i.test(t)) return "pending";
    if (/\breservation\s+(?:was\s+|has been\s+)?(?:successfully\s+)?(?:created|confirmed|saved)\b|\bbooking\s+(?:was\s+|has been\s+)?(?:successfully\s+)?confirmed\b|\b(?:reservation|booking)\s+(?:created|saved)\s+successfully\b/i.test(t)) return "success";
    return "response";
  }
  root.HKU = {BASE,ROOMS,FORM_OPEN_LEAD_MS,CREATE_AFTER_RELEASE_SECONDS,CAPTCHA_BEFORE_RELEASE_SECONDS,FIXED_CAPTCHA_WAIT_SECONDS,addDays,endDate,timingSettings,hkParts,hkStamp,timeValue,hkEpoch,reservationURL,parseReservationURL,validate,plan,classify};
  if (typeof module !== "undefined") module.exports = root.HKU;
})(typeof globalThis !== "undefined" ? globalThis : this);
