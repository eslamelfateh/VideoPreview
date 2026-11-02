/**
 * Arabic / English interface. The language is remembered per browser; switching
 * reloads the page. Untranslated strings fall back to English.
 */
const AR: Record<string, string> = {
  // top bar
  'Add media': 'إضافة ملفات', 'Uploading…': 'جاري الرفع…', 'Quick draft': 'نسخة سريعة', 'Export MP4': 'تصدير MP4', 'Download': 'تحميل',
  'Clear': 'تفريغ', 'Delete': 'حذف', 'Cancel': 'إلغاء', 'Empty this project (clips, steps, versions)?': 'تفريغ المشروع ده (الكليبات والخطوات والنسخ)؟',
  'Exporting': 'جاري التصدير', 'reconnecting…': 'بيعيد الاتصال…', 'Versions': 'النسخ', 'Save': 'حفظ', 'Open': 'فتح', 'Keep': 'سيبه',
  'Name this version': 'اسم النسخة', 'Save the current edit to compare it with another one later, or ask the agent for two versions.': 'احفظ التعديل الحالي عشان تقارنه بنسخة تانية بعدين، أو اطلب من الـ agent يعملك نسختين.',
  'Rename': 'تغيير الاسم', 'Review link': 'لينك المراجعة', 'Anyone with it can watch this project and pin notes for the agent, but not edit.': 'أي حد معاه اللينك يقدر يتفرج على المشروع ويسيب ملاحظات للـ agent، بس ميقدرش يعدّل.',
  'Copy': 'نسخ', 'Copied': 'اتنسخ', 'Turn off': 'إيقاف', 'Create review link': 'عمل لينك مراجعة', 'New project name': 'اسم مشروع جديد', 'New': 'جديد', 'open now': 'مفتوح دلوقتي',
  'Drop to add to the timeline': 'سيب الملف هنا عشان يتضاف للـ timeline', 'Connecting to LiveCut…': 'بيتصل بـ LiveCut…', 'Loading…': 'جاري التحميل…',
  // transport
  'follow agent': 'تابع الـ agent', 'live preview': 'معاينة مباشرة', 'paused · you have control': 'متوقف · التحكم معاك', 'note waiting for the agent': 'ملاحظة مستنية الـ agent', 'notes waiting for the agent': 'ملاحظات مستنية الـ agent',
  'Play': 'تشغيل', 'Pause': 'إيقاف مؤقت', 'Resume': 'كمّل',
  // timeline
  'notes': 'ملاحظات', 'video': 'فيديو', 'b-roll': 'B-roll', 'text': 'نص', 'fx': 'مؤثرات', 'audio': 'صوت', 'Drag here to select a range': 'اسحب هنا عشان تحدد جزء',
  // inspector
  'Project': 'المشروع', 'Starts at': 'بيبدأ عند', 'From (source)': 'من (الأصل)', 'To (source)': 'لحد (الأصل)', 'Volume': 'الصوت', 'Mute': 'كتم', 'Fade in': 'ظهور تدريجي', 'Fade out': 'اختفاء تدريجي',
  'Speed': 'السرعة', 'Fade from black': 'ظهور من الأسود', 'Fade to black': 'اختفاء للأسود', 'Reduce background noise': 'تقليل الدوشة', '(on export)': '(في التصدير)',
  'Split at playhead': 'قص عند المؤشر', 'Delete, keep gap': 'حذف وسيب المكان فاضي', 'Where': 'المكان', 'Text': 'النص', 'Start': 'البداية', 'End': 'النهاية', 'Color': 'اللون', 'Highlight': 'لون الكلمة',
  'Title': 'عنوان', 'Caption': 'كابشن', 'top': 'فوق', 'middle': 'النص', 'bottom': 'تحت', 'Use this look for all captions': 'استخدم الشكل ده لكل الكابشن',
  'Word-by-word highlight is kept if you only change spelling, not the number of words.': 'إضاءة الكلمات بتفضل لو غيّرت الإملاء بس، مش عدد الكلمات.',
  'Amount': 'القوة', 'Smoothness (ease)': 'النعومة', 'Mark done': 'خلصت', 'Reopen': 'افتحها تاني', 'Do this here': 'اعمل كده هنا', "Don't touch this part": 'متلمسش الجزء ده',
  'What should the agent do here?': 'الـ agent يعمل إيه هنا؟', 'Why (the agent sees this)': 'ليه؟ (الـ agent بيشوف ده)',
  'Tell the agent what to do (or not do) here': 'قول للـ agent يعمل (أو ميعملش) إيه هنا', 'Add note': 'إضافة ملاحظة', "🔒 Lock: don't touch": '🔒 قفل: متلمسوش',
  'Volume for this part': 'صوت الجزء ده', 'Apply volume': 'طبّق الصوت', 'Zoom here': 'زوم هنا', 'Title here': 'عنوان هنا', 'Cut out': 'قص الجزء ده',
  'Click anything on the timeline to edit it. Drag on the ruler to select a range, then cut it, change its volume, or leave a note for the agent.': 'دوس على أي حاجة في الـ timeline عشان تعدّلها. اسحب على المسطرة عشان تحدد جزء، وبعدين قصه أو غيّر صوته أو سيب ملاحظة للـ agent.',
  'play / pause': 'تشغيل / إيقاف', 'split at playhead': 'قص عند المؤشر', 'delete selected': 'حذف المحدد', 'note for the agent here': 'ملاحظة للـ agent هنا', 'add title / zoom here': 'عنوان / زوم هنا', 'one frame (Shift: 1s)': 'فريم واحد (Shift: ثانية)', 'undo last step': 'رجوع آخر خطوة',
  'Audio': 'الصوت', 'Lower the music while people talk': 'وطّي الموسيقى وقت الكلام', 'Music under speech': 'الموسيقى تحت الكلام', 'Normalize loudness (-14 LUFS)': 'ظبط علو الصوت (-14 LUFS)', 'Re-measure loudness': 'قيس علو الصوت تاني', 'Measuring…': 'بيقيس…', 'Off': 'إيقاف',
  'Framing': 'الكادر', 'Left ↔ right': 'شمال ↔ يمين', 'Up ↕ down': 'فوق ↕ تحت', 'The video is a different shape than the canvas. Move the frame at the playhead; it eases between keyframes.': 'الفيديو شكله مختلف عن الكادر. حرّك الكادر عند المؤشر، وهيتحرك بنعومة بين النقط.',
  'Karaoke': 'كاريوكي', 'Box': 'صندوق', 'One word': 'كلمة كلمة', 'Minimal': 'بسيط', 'Bold': 'عريض',
  // agent panel
  'Agent': 'الـ Agent', 'connected': 'متصل', 'not connected': 'مش متصل', 'Live': 'مباشر', 'Step': 'خطوة بخطوة',
  'Drop a video into the editor.': 'اسحب فيديو جوه المحرر.', 'Connect an agent. For Claude Code:': 'وصّل agent. لـ Claude Code:', 'Ask it for an edit, for example:': 'اطلب منه تعديل، مثلاً:',
  'Every edit appears here as a step you can undo, compare before/after, or (in Step mode) accept or reject before the agent continues.': 'كل تعديل بيظهر هنا خطوة تقدر ترجعها، أو تقارن قبل وبعد، أو (في وضع خطوة بخطوة) تقبلها أو ترفضها قبل ما الـ agent يكمّل.',
  'Undo': 'رجوع', 'Redo': 'إعادة', 'Hold: before': 'اضغط: قبل', 'Accept': 'قبول', 'Reject': 'رفض', 'you': 'انت', 'undone': 'اترجعت', 'needs review': 'محتاجة مراجعة', 'rejected': 'مرفوضة',
  'Optional note, e.g. make it slower': 'ملاحظة اختيارية، مثلاً خليه أبطأ', 'Send': 'إرسال', 'Message the agent mid-edit, e.g. خلّي الكابشن أصفر': 'ابعت رسالة للـ agent وهو شغال، مثلاً: خلّي الكابشن أصفر',
  "message waiting for the agent's next step": "رسالة مستنية خطوة الـ agent الجاية", "messages waiting for the agent's next step": "رسائل مستنية خطوة الـ agent الجاية",
  'The agent is asking': 'الـ agent بيسأل', 'jump there': 'روح هناك', 'Type an answer': 'اكتب ردك', 'Answer': 'رد',
  // review
  'Leave a note': 'سيب ملاحظة', 'Send note': 'ابعت الملاحظة', '🔒 Keep this part as is': '🔒 سيب الجزء ده زي ما هو', 'Sent. The editor will see it on the timeline.': 'اتبعتت. المحرر هيشوفها على الـ timeline.',
  'Play the video, then drag on the ruler above the timeline to pick a moment (or use the playhead). Your note is pinned there for the editor and the AI agent.': 'شغّل الفيديو، وبعدين اسحب على المسطرة فوق الـ timeline عشان تختار لحظة (أو استخدم المؤشر). ملاحظتك هتتثبت هناك للمحرر وللـ agent.',
  'Review': 'مراجعة',
};

const KEY = 'livecut-lang';
function initial(): 'ar' | 'en' {
  try { const v = localStorage.getItem(KEY); if (v === 'ar' || v === 'en') return v; } catch { /* ignore */ }
  return navigator.language?.toLowerCase().startsWith('ar') ? 'ar' : 'en';
}
export const LANG = initial();
export const t = (s: string) => (LANG === 'ar' ? AR[s] ?? s : s);
export function setLang(l: 'ar' | 'en') {
  try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  location.reload();
}
if (typeof document !== 'undefined') {
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === 'ar' ? 'rtl' : 'ltr';
}
