"""OpenAI vision receives every PDF page, including scanned evidence."""
import base64
import unittest
import pymupdf
import llm_provider


class PdfRendering(unittest.TestCase):
    def pdf(self, pages):
        with pymupdf.open() as doc:
            for _ in range(pages):
                doc.new_page().insert_text((72, 72), 'Synthetic evidence')
            return doc.tobytes()

    def test_openai_pdf_chain_uses_page_images(self):
        entry={'provider':'openai','model':'vision-model','api_key':'test'}
        chain,dropped=llm_provider.provider_chain({'primary':entry},'application/pdf')
        self.assertEqual(chain,[entry]); self.assertFalse(dropped)
        messages=llm_provider.messages_for(entry,'Read all pages',self.pdf(2),'application/pdf')
        content=messages[1].content
        self.assertEqual(len(content),2)
        for block in content:
            prefix, encoded=block['image_url']['url'].split(',',1)
            self.assertEqual(prefix,'data:image/png;base64')
            self.assertTrue(base64.b64decode(encoded).startswith(b'\x89PNG'))

    def test_large_pdf_is_rejected_without_truncation(self):
        with self.assertRaises(ValueError):
            llm_provider.messages_for({'provider':'openai'},'Read',self.pdf(31),'application/pdf')

    def test_direct_pdf_provider_is_unchanged(self):
        content=llm_provider.messages_for({'provider':'anthropic'},'Read',self.pdf(1),'application/pdf')[1].content
        self.assertEqual(content[0]['source']['media_type'],'application/pdf')
