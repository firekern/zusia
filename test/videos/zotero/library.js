// Runs inside the demo Zotero: a small library of well-known papers with their arXiv PDFs.
// The caller defines pdfDir.
const PAPERS = [
	{ type: "conferencePaper", title: "Attention Is All You Need", date: "2017", pub: "Advances in Neural Information Processing Systems", arxiv: "1706.03762",
		authors: ["Ashish Vaswani", "Noam Shazeer", "Niki Parmar", "Jakob Uszkoreit", "Llion Jones", "Aidan N. Gomez", "Łukasz Kaiser", "Illia Polosukhin"] },
	{ type: "conferencePaper", title: "Deep Residual Learning for Image Recognition", date: "2016", pub: "Proceedings of the IEEE Conference on Computer Vision and Pattern Recognition", arxiv: "1512.03385",
		authors: ["Kaiming He", "Xiangyu Zhang", "Shaoqing Ren", "Jian Sun"] },
	{ type: "conferencePaper", title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding", date: "2019", pub: "Proceedings of NAACL-HLT", arxiv: "1810.04805",
		authors: ["Jacob Devlin", "Ming-Wei Chang", "Kenton Lee", "Kristina Toutanova"] },
	{ type: "conferencePaper", title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale", date: "2021", pub: "International Conference on Learning Representations", arxiv: "2010.11929",
		authors: ["Alexey Dosovitskiy", "Lucas Beyer", "Alexander Kolesnikov", "Dirk Weissenborn", "Xiaohua Zhai", "Thomas Unterthiner", "Mostafa Dehghani", "Matthias Minderer", "Georg Heigold", "Sylvain Gelly", "Jakob Uszkoreit", "Neil Houlsby"] },
	{ type: "conferencePaper", title: "Language Models are Few-Shot Learners", date: "2020", pub: "Advances in Neural Information Processing Systems", arxiv: "2005.14165",
		authors: ["Tom B. Brown", "Benjamin Mann", "Nick Ryder", "Melanie Subbiah", "Jared Kaplan", "Prafulla Dhariwal", "Arvind Neelakantan", "Pranav Shyam", "Girish Sastry", "Amanda Askell"] },
	{ type: "conferencePaper", title: "Adam: A Method for Stochastic Optimization", date: "2015", pub: "International Conference on Learning Representations", arxiv: "1412.6980",
		authors: ["Diederik P. Kingma", "Jimmy Ba"] },
];
let existing = await Zotero.Items.getAll(Zotero.Libraries.userLibraryID, true);
let ids = {};
for (let paper of PAPERS) {
	let found = existing.find(i => i.isRegularItem() && i.getField("title") === paper.title);
	if (found) {
		ids[paper.arxiv] = found.id;
		continue;
	}
	let item = new Zotero.Item(paper.type);
	item.libraryID = Zotero.Libraries.userLibraryID;
	item.setField("title", paper.title);
	item.setField("date", paper.date);
	item.setField("proceedingsTitle", paper.pub);
	item.setField("url", "https://arxiv.org/abs/" + paper.arxiv);
	item.setCreators(paper.authors.map((name) => {
		let parts = name.split(" ");
		return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1], creatorType: "author" };
	}));
	await item.saveTx();
	await Zotero.Attachments.importFromFile({ file: pdfDir + "/" + paper.arxiv + ".pdf", parentItemID: item.id });
	ids[paper.arxiv] = item.id;
}
return ids;
